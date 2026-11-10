# parcel-mcp

A small [MCP](https://modelcontextprotocol.io) server that exposes your [Parcel](https://parcelapp.net) app's deliveries to any MCP client — ChatGPT, Claude, other agents — deployed as a **Cloudflare Worker**. The Worker is its own OAuth 2.1 authorization server. **Cloudflare Access** is used only to prove that the owner is the person approving a grant.

It lets an authenticated client ask *"what packages are on their way?"* and add a tracking number Parcel didn't pick up on its own. It never exposes your Parcel API key and never logs delivery contents.

An agent that calls the server regularly does not need a scheduled sign-in. Access tokens last one hour. Each refresh rotates the refresh token and moves its expiry to 90 days after that use. The grant ends only after 90 days without a successful refresh.

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `get_connection_status` | none | Reports the identity that approved the grant, and whether the server is configured. Reveals no deliveries and no credentials. |
| `list_active_deliveries` | none | Returns the account's active deliveries — carrier, description, tracking number, expected dates, status, and up to 30 events each. Parcel serves cached data; this does not poll carriers. |
| `add_delivery` | `tracking_number`, `carrier_code`, `description`; optional `postcode`, `email` | Adds one delivery to the account. Parcel allows 20 add requests per day including failed ones, so clients should check `list_active_deliveries` first. Carrier codes: [supported_carriers.json](https://api.parcel.app/external/supported_carriers.json). |

The first two are annotated read-only. `add_delivery` is the only write path, and it can only create — nothing can modify or delete a delivery. A grant carries `active_deliveries_read` and `add_delivery`. Clients that omit `scope` receive both.

## How it works

```text
MCP client ──HTTPS──> Worker
                         ├─ /.well-known/oauth-*     discovery
                         ├─ /register                dynamic client registration
                         ├─ /oauth/token             code exchange, refresh, revocation
                         ├─ /authorize               owner approval (Cloudflare Access, then a consent page)
                         └─ /mcp                      Parcel tools, bearer access token only
                                          └──GET/POST──> api.parcel.app
```

- **The Worker** is the OAuth 2.1 authorization server ([MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)): authorization-code + PKCE (`S256`), refresh tokens, and dynamic client registration. Grants, clients, and tokens are stored in a KV namespace bound as `OAUTH_KV`. The library is [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider).
- **`/authorize` is the only path behind Cloudflare Access.** The Access login proves who the approver is. The Worker checks the `Cf-Access-Jwt-Assertion` JWT (team JWKS, issuer, audience) and then shows a consent page naming the client and the host that will receive tokens. Allow issues the grant. `/mcp` reads only the bearer access token this Worker issued.
- **`/mcp` accepts only an access token this Worker issued.** A missing, invalid, or expired token gets `401` with a `WWW-Authenticate` challenge pointing at the protected-resource metadata. An old Access session or service token is not a credential for `/mcp`.
- **The Parcel API key stays a Worker secret.** The Worker calls Parcel with it and returns a filtered result. The key is not a client credential.

Token lifetimes live in `src/oauth.ts`: `ACCESS_TOKEN_TTL_SECONDS` (1 hour) and `REFRESH_GRANT_TTL_SECONDS` (90 days). The same 90-day value is the new grant's lifetime and the idle lifetime. Every successful refresh rotates the refresh token and starts the 90 days over. The immediately previous refresh token stays valid until the replacement is used, so a client that lost the refresh response can retry once. After that use, the older token is rejected.

## Security model

- **Access is the owner's login. The consent page is the grant.** Anyone can register a client at `/register`. Nobody receives a token unless the owner passes Access on `/authorize` and chooses Allow. The page shows the client's name and the redirect host. Names from dynamic registration are not verified. There is no user allow-list and no admin UI in the Worker; the Access policy on `/authorize` decides who may see that page.
- **A link is not enough.** Access would otherwise send the browser back to a crafted `/authorize` URL after login and an automatic grant would mint a 90-day refresh token. The consent handle is single-use and bound to the browser that opened the page.
- **Never serve this on `*.workers.dev`.** The issuer and the resource URL are the request origin. `workers_dev` is off; serve one hostname only. A second route would be a second issuer.
- **The Parcel API key is a Worker secret.** It never appears in source, logs, responses, or client configuration. The server redacts the key from any upstream text before returning it, and classifies upstream errors without echoing their bodies.
- **Fail closed.** If the Access variables are missing, `/authorize` refuses every grant. If the access token has no identity, tool calls are refused. If the key or the rate limiter is unavailable, data calls return an error rather than leaking or proceeding.
- **Refresh grants have no absolute end date.** A stolen refresh token keeps working for as long as it is used at least every 90 days. There is no revocation UI. To cut grants off, delete the keys in the OAuth KV namespace (or create a new namespace, point `OAUTH_KV_NAMESPACE_ID` at it, and redeploy) and connect the agents again. A client that still holds a token can also revoke it at `POST /oauth/token` with `token_type_hint=refresh_token` ([RFC 7009](https://datatracker.ietf.org/doc/html/rfc7009)).
- **KV is eventually consistent.** A rotated or deleted token can be accepted once more from a stale replica.
- **Client ID Metadata Documents** are enabled, so a client may use an HTTPS URL as its `client_id`. The Worker fetches that document. The `global_fetch_strictly_public` compatibility flag keeps that fetch on the public internet. Dynamic registration remains available for clients that do not use a metadata document.

## Rate limiting

Parcel's API is read **at most once every ~3 minutes**, enforced by one KV key that expires when the window closes (see `src/rate.ts`). Calls inside the window are refused with a `retry_at` time and never reach Parcel. KV is eventually consistent, so two simultaneous calls can occasionally both pass; Parcel answers the extra one with a 429, which the server reports cleanly. **All deployments that share one Parcel API key must share one rate-limit KV namespace**, or the shared allowance is not enforced. The OAuth namespace is separate and does not throttle Parcel.

## Privacy

Delivery data — tracking numbers, descriptions, events — is personal data. The Worker does not log it, and you should not add logging that does. OAuth error logs record only the HTTP status and the OAuth error code. The approving user's email is stored in the encrypted token props, not in the grant's plaintext metadata.

## Deploy your own

Prerequisites: a Cloudflare account, a domain on Cloudflare, a Parcel API key ([Parcel's API docs](https://parcelapp.net/help/api-view-deliveries.html)), and Node.js 22 or newer.

```sh
npm ci
npm test            # offline tests; no network or credentials
npm run typecheck
```

1. **Create two KV namespaces.** One throttles Parcel reads. One stores OAuth clients, grants, and tokens. Do not reuse one namespace for both.

   ```sh
   npx wrangler kv namespace create RATE_LIMIT
   npx wrangler kv namespace create OAUTH_KV
   ```

   For a deploy from GitHub, do not commit the ids. Set repository variables on the `default-branch` environment (Settings → Environments → `default-branch` → Environment variables):

   - `RATE_LIMIT_KV_NAMESPACE_ID`
   - `OAUTH_KV_NAMESPACE_ID`

   The deploy workflow writes those into `wrangler.json` by binding name. `OAUTH_KV_NAMESPACE_ID` has to exist before the merge that adds this binding. If it is missing, the deploy fails and the previous Worker keeps serving.

   For a manual deploy from a checkout, paste the ids into `wrangler.json` and do not commit them.

2. **Set the Parcel secret and deploy** (GitHub does this on merge to `main`; a workstation deploy is not the path this repo uses).

   ```sh
   npx wrangler secret put PARCEL_API_KEY
   npx wrangler deploy
   ```

3. **Attach one hostname** (Workers & Pages → your worker → Settings → Domains & Routes → add a custom domain on your zone, for example `parcel.example.com`). The config sets `workers_dev: false` so the Worker is not also served on `*.workers.dev`.

4. **Set the Access variables** on the Worker (Settings → Variables and Secrets, type *Plaintext*). `wrangler.json` sets `keep_vars` so later deploys preserve them:

   - `ACCESS_TEAM_DOMAIN` — your team domain, such as `your-team.cloudflareaccess.com`, with no `https://`.
   - `ACCESS_AUD` — the AUD tag of the Access application that protects `/authorize` (step 5). If you edit the existing application and its tag does not change, leave the variable as it is.

5. **Scope Cloudflare Access to `/authorize` only, and turn Managed OAuth off.** This is a dashboard change. Do it after the new Worker is deployed, then reconnect clients. While the old whole-host application is still in front, Access answers discovery and `/mcp` itself and this server's tokens are not what clients see.

   In the [Cloudflare dashboard](https://dash.cloudflare.com/), go to **Zero Trust → Access controls → Applications** (some dashboards still label this **Access → Applications**).

   1. Open the self-hosted application for this Worker's hostname. Edit that application. Do not leave a second application that still matches the whole hostname or `/mcp`. A more specific path wins only for the path it names; a whole-host application would keep protecting everything else.
   2. Set the application path to exactly `authorize`. The public hostname stays the Worker's custom domain. Do not use `authorize/*`: a wildcard path does not cover the path itself, so `/authorize` would miss the policy. Do not leave the path empty. Query strings are not part of an application path; a request to `/authorize?response_type=code&...` still matches the path `authorize`.
   3. Keep a single **Allow** policy for the owner (for example *Include → Emails* with that address, and One-time PIN or your identity provider). Remove any **Service Auth** policy that was added so a machine could call `/mcp`. A service token that can open `/authorize` can approve a 90-day grant without an interactive login.
   4. Open **Advanced settings** and turn **Managed OAuth off**, then save. Managed OAuth replaces this server's own `WWW-Authenticate` and `/.well-known` documents. `/authorize` needs Access's browser login, not Access acting as the OAuth server. The same docs: [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) ("do not enable this feature" when the origin runs its own OAuth server) and [Application paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).
   5. Copy the application's **AUD** tag. If it differs from the Worker's `ACCESS_AUD` variable, update that variable. `ACCESS_TEAM_DOMAIN` stays the team domain.

   Confirm, while logged out of Access:

   - `GET https://<your-hostname>/.well-known/oauth-authorization-server` is JSON whose `issuer` is `https://<your-hostname>`, not a `cloudflareaccess.com` host.
   - `GET https://<your-hostname>/mcp` with no token is `401` and the `WWW-Authenticate` header's `resource_metadata` points at `https://<your-hostname>/.well-known/oauth-protected-resource/mcp`.
   - Opening `https://<your-hostname>/authorize` in a browser shows the Access login, not a JSON `invalid_token` body.

6. **Reconnect each agent once** after the Access change. See below. Do not rotate `PARCEL_API_KEY` for this cutover.

### Deploying from GitHub

`.github/workflows/deploy.yml` deploys on every push to `main` with Cloudflare's [wrangler-action](https://github.com/cloudflare/wrangler-action). It needs, in the repository's `default-branch` environment: the secret `CLOUDFLARE_API_TOKEN` (an API token with *Workers Scripts: Edit* on your account) and the variables `CLOUDFLARE_ACCOUNT_ID`, `RATE_LIMIT_KV_NAMESPACE_ID`, and `OAUTH_KV_NAMESPACE_ID`. In a fork the workflow does nothing until you add your own.

## Connect a client

Point the client at `https://<your-hostname>/mcp` (Streamable HTTP).

1. The client reads `/.well-known/oauth-protected-resource/mcp`, then the authorization-server metadata on the same origin.
2. It registers at `/register`, or presents a Client ID Metadata Document.
3. It opens the browser at `/authorize` with PKCE. You sign in through Access, read the client name and the redirect host, and choose **Allow**.
4. The client stores the refresh token. Later calls refresh on their own. You sign in again only to approve a new client, or after 90 days in which that client never successfully refreshed.

Redirect URLs must be `https`, loopback `http` (`localhost`, `127.0.0.1`, `::1`), or a private-use scheme such as `cursor://` for a native app. The consent page shows where the code will be sent. Remote `http` is rejected.

`get_connection_status` then reports `authenticated_user_id` and `authenticated_user_email` from the Access login that approved the grant (a service token used at `/authorize` has an id and no email).

## Project layout

| Path | Role |
| --- | --- |
| `src/mcp.ts` | Transport-agnostic MCP core: protocol handling, the tools, response filtering, key redaction, safe error classification. The caller passes the approved identity, fetch, clock, and rate reservation. |
| `src/oauth.ts` | OAuth provider wiring, token lifetimes, `/authorize` consent, and the `/mcp` bearer check. |
| `src/access.ts` | Verifies the Cloudflare Access JWT on `/authorize` with [`jose`](https://github.com/panva/jose). |
| `src/rate.ts` | The KV-backed Parcel read throttle. |
| `src/index.ts` | Worker entry point. Wires Access, KV, and the Parcel secret. |
| `test/` | Mock-only tests. No real Parcel key, Access tenant, or network. |
| `wrangler.json` | Worker configuration. Generic: the two KV namespace ids are the values a deployment fills in. `global_fetch_strictly_public` and `cache_option_enabled` are required by Client ID Metadata Document fetches. |

## License

MIT — see `LICENSE`.
