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

Token lifetimes live in `src/oauth.ts`: `ACCESS_TOKEN_TTL_SECONDS` (1 hour) and `REFRESH_GRANT_TTL_SECONDS` (90 days). The same 90-day value is the new grant's lifetime and the idle lifetime. Every successful refresh rotates the refresh token and starts the 90 days over. The immediately previous refresh token stays valid until the replacement is used, so a client that lost the refresh response can retry with it. Once the replacement is used, the older token is rejected.

## Security model

- **Access is the owner's login. The consent page is the grant.** Anyone can register a client at `/register`. Nobody receives a token unless the owner passes Access on `/authorize` and chooses Allow. The page shows the client's name and the redirect host. Names from dynamic registration are not verified. There is no user allow-list and no admin UI in the Worker; the Access policy on `/authorize` decides who may see that page.
- **A link is not enough.** Access would otherwise send the browser back to a crafted `/authorize` URL after login and an automatic grant would mint a 90-day refresh token. The consent handle is single-use and bound to the browser that opened the page.
- **Never serve this on `*.workers.dev`.** The issuer and the resource URL are the request origin. `workers_dev` is off; serve one hostname only. A second route would be a second issuer.
- **The Parcel API key is a Worker secret.** It never appears in source, logs, responses, or client configuration. The server redacts the key from any upstream text before returning it, and classifies upstream errors without echoing their bodies.
- **Fail closed.** If the Access variables are missing, `/authorize` refuses every grant. If the access token has no identity, tool calls are refused. If the key or the rate limiter is unavailable, data calls return an error rather than leaking or proceeding.
- **Refresh grants have no absolute end date.** A stolen refresh token can keep working while it is used at least every 90 days. Use the targeted revocation and containment procedures below; removing an Access session does not revoke Worker-issued grants.
- **KV is eventually consistent.** A stale replica can temporarily accept a rotated or deleted token; revocation is not globally instantaneous.
- **Client ID Metadata Documents** are enabled, so a client may use an HTTPS URL as its `client_id`. The Worker fetches that document. The `global_fetch_strictly_public` compatibility flag keeps that fetch on the public internet. Dynamic registration remains available for clients that do not use a metadata document.

## Rate limiting

The read throttle uses a KV key to target one upstream attempt every three minutes. A visible reservation returns `retry_at` without calling Parcel. KV is eventually consistent and its read/write pair is not atomic: concurrent calls can admit multiple attempts. This is a **best-effort throttle**, not a strict quota. Parcel's own 429 response remains authoritative. Deployments sharing a Parcel API key should share the `RATE_LIMIT` namespace; `OAUTH_KV` is separate.

A native Cloudflare rate limiter also protects public requests before OAuth dispatch, targeting 60 requests per minute per client IP in each Cloudflare location. Shared egress IPs share this allowance. Cloudflare's counters are approximate; this is abuse mitigation, not a global quota. Denial returns 429 with `Retry-After`; an unavailable binding returns 503. Token and consent POST bodies are limited to 64 KiB; registration retains the provider's 1 MiB limit and MCP requests retain their 8 KiB limit.

## Privacy

Delivery data — tracking numbers, descriptions, events — is personal data. The Worker does not log it, and you should not add logging that does. OAuth error logs record only the HTTP status and the OAuth error code. Query strings are redacted in Worker observability; traces are sampled at 10%. The approving user's email is stored in the encrypted token props, not in the grant's plaintext metadata.

## Deploy your own

Prerequisites: a Cloudflare account, a domain on Cloudflare, a Parcel API key ([Parcel's API docs](https://parcelapp.net/help/api-view-deliveries.html)), and Node.js 22 or newer.

```sh
npm ci
npm test            # offline tests; no network or credentials
npm run typecheck
```

1. Create separate `RATE_LIMIT` and `OAUTH_KV` namespaces in Cloudflare. The first holds read reservations; the second holds clients, grants, and tokens.
2. Configure the GitHub `default-branch` environment, restricted to `main`, with secret `CLOUDFLARE_API_TOKEN` (Workers Scripts: Edit for your account) and variables `CLOUDFLARE_ACCOUNT_ID`, `RATE_LIMIT_KV_NAMESPACE_ID`, and `OAUTH_KV_NAMESPACE_ID`. The workflow fills the two KV IDs by binding name; do not commit deployment IDs. Choose a rate-limit `namespace_id` in `wrangler.json` that is unused in your account; bindings with the same ID share counters.
3. Deploy through the GitHub workflow, then set the Worker secret `PARCEL_API_KEY` in the Cloudflare dashboard. It is never a client credential. Attach exactly one custom hostname, such as `parcel.example.com`; keep `workers_dev` disabled.
4. Create a self-hosted Cloudflare Access application for exactly that hostname's `authorize` path, with an Allow policy restricted to the owner. Do not use `authorize/*`, a whole-host application, or a Service Auth policy. Leave **Managed OAuth disabled**: the Worker provides OAuth discovery and tokens. See [Access paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/) and [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).
5. Set the Worker's plaintext variables `ACCESS_TEAM_DOMAIN` (for example `your-team.cloudflareaccess.com`, without `https://`) and `ACCESS_AUD` (the Access application's AUD tag). `keep_vars` preserves them across deploys. Missing values prevent new grants.
6. Verify discovery returns JSON with your hostname as `issuer`, unauthenticated `/mcp` returns 401 with protected-resource metadata in its challenge, and `/authorize` requires the owner's Access login. Then connect only the clients you intend to authorize.

### Delivery and releases

`.github/workflows/deploy.yml` runs on every push to `main`. A credential-free job installs the lockfile and runs the existing Vitest suite and TypeScript check. Both deployment and source release depend on its success. These are deployment gates; the repository's shared PR check remains its required merge check.

Deployment uses the configured GitHub environment and Cloudflare's SHA-pinned Wrangler action. The serialized workflow also runs the local `tag-package-release.sh`, creating an immutable annotated `parcel-mcp--v<version>` tag and a GitHub source release. It does not publish an npm package. Source release and Worker deployment have separate job results: verify both before declaring a version shipped.

For a new release, update `package.json`, the root package entry and version in `package-lock.json`, the MCP `serverInfo.version` in `src/mcp.ts`, and `CHANGELOG.md`. Existing tags are never moved. Dependency or documentation changes that leave the version unchanged do not create another release. Forks must supply their own deployment settings; estate-specific shared PR governance is separate from this Worker delivery workflow.

## Operations and recovery

- After deployment, confirm the workflow's verification and deployment jobs succeeded, inspect the active Worker version in Cloudflare, and call `get_connection_status` using an already authorized client. This does not spend Parcel's read allowance. Check source release separately. No delivery write is needed for a routine smoke check.
- A client can revoke its own grant using an RFC 7009 form POST to `/oauth/token` with its `client_id`, `token` (refresh token), and `token_type_hint=refresh_token`, plus its registered client authentication method if applicable. Use the client's secure credential storage; never put tokens into command history or logs. Revoking the refresh token removes that grant and its access tokens. There is no operator revocation UI.
- If a credential is compromised and the client cannot revoke it, contain access at Cloudflare first. Replacing `OAUTH_KV` with an empty namespace and redeploying invalidates **all** clients and grants, requires fresh registration and consent, and must be a deliberate account-wide recovery decision. Do not clear OAuth storage for an ordinary sign-in error. Access policy changes alone do not invalidate existing Worker tokens.
- For a defective code release, revert the offending change through a PR to redeploy the corrected source. For urgent recovery, an authorized operator can roll back the Worker deployment in Cloudflare, then reconcile `main` before the next deploy. Worker rollback does not restore KV data or revoke grants. See [rollback limitations](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).
- Rotate a compromised Parcel API key in Parcel and update the Worker secret through the dashboard. Do not expose its value in a ticket or client configuration.
- If `add_delivery` times out or reports an uncertain upstream failure, inspect Parcel before retrying. The upstream operation may have succeeded; blindly retrying can duplicate a delivery or spend its daily allowance.

## Connect a client

Point the client at `https://<your-hostname>/mcp` (Streamable HTTP).

1. The client reads `/.well-known/oauth-protected-resource/mcp`, then the authorization-server metadata on the same origin.
2. It registers at `/register`, or presents a Client ID Metadata Document.
3. It opens the browser at `/authorize` with PKCE. You sign in through Access, read the client name and the redirect host, and choose **Allow**.
4. The client stores the refresh token. Later calls refresh on their own. You sign in again only to approve a new client, or after 90 days in which that client never successfully refreshed.

Redirect URLs must be `https`, loopback `http` (`localhost`, `127.0.0.1`, `::1`), or a private-use scheme such as `cursor://` for a native app. The consent page shows where the code will be sent. Remote `http` is rejected.

`get_connection_status` then reports `authenticated_user_id` and `authenticated_user_email` from the Access login that approved the grant.

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
