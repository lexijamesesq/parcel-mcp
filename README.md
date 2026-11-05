# parcel-mcp

A small [MCP](https://modelcontextprotocol.io) server that exposes your [Parcel](https://parcelapp.net) app's deliveries to any MCP client — ChatGPT, Claude, other agents — deployed as a **Cloudflare Worker** and gated by **Cloudflare Access**.

It lets an authenticated client ask *"what packages are on their way?"* and add a tracking number Parcel didn't pick up on its own. It never exposes your Parcel API key and never logs delivery contents.

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `get_connection_status` | none | Reports whether the caller is authenticated and whether the server is configured. Reveals no deliveries and no credentials. |
| `list_active_deliveries` | none | Returns the account's active deliveries — carrier, description, tracking number, expected dates, status, and up to 30 events each. Parcel serves cached data; this does not poll carriers. |
| `add_delivery` | `tracking_number`, `carrier_code`, `description`; optional `postcode`, `email` | Adds one delivery to the account. Parcel allows 20 add requests per day including failed ones, so clients should check `list_active_deliveries` first. Carrier codes: [supported_carriers.json](https://api.parcel.app/external/supported_carriers.json). |

The first two are annotated read-only. `add_delivery` is the only write path, and it can only create — nothing can modify or delete a delivery. Every connected client can call all three; restrict who connects with your Access policy.

## How it works

```text
MCP client ──HTTPS──> Cloudflare Access ──> Worker (/mcp) ──GET──> api.parcel.app
                      (authenticates)        (verifies JWT,
                                               rate-limits,
                                               filters response)
```

- **Cloudflare Access** sits in front of the Worker and authenticates every caller. It supports two caller kinds on the same application:
  - **Managed OAuth** for clients driven by a human (ChatGPT, Claude, CLIs) — the user logs in through your identity provider once and the client receives an OAuth token.
  - **Service tokens** for unattended machines (background agents, cron) — a client ID and secret sent as headers.
- **The Worker** verifies the signed JWT that Access attaches (`Cf-Access-Jwt-Assertion`) on every request, then calls Parcel with your API key and returns a filtered result.

## Security model

- **Access is the gate; the Worker is the lock.** The Worker cryptographically verifies Access's JWT (signature against your team's public keys, plus issuer and audience) on every data call. A forged or client-supplied header cannot pass, because the client does not hold Access's signing key. There is **no per-user allow-list in the application** — *who* may connect is decided entirely by your Access policy. Set that policy to exactly the people and service tokens you intend.
- **Never serve this on `*.workers.dev`.** That URL would bypass Access. Disable `workers_dev` in your Worker configuration; serve it only at a hostname behind Access.
- **The Parcel API key is a Worker secret.** It never appears in source, logs, responses, or client configuration. The server redacts the key from any upstream text before returning it, and classifies upstream errors without echoing their bodies.
- **Fail closed.** If the key, the identity verifier, or the rate limiter is unavailable, data calls return an error rather than leaking or proceeding.

## Rate limiting

Parcel's API is read **at most once every ~3 minutes**, enforced by one KV key that expires when the window closes (see `src/rate.ts`). Calls inside the window are refused with a `retry_at` time and never reach Parcel. KV is eventually consistent, so two simultaneous calls can occasionally both pass; Parcel answers the extra one with a 429, which the server reports cleanly. **All deployments that share one Parcel API key must share one KV namespace**, or the shared allowance is not enforced.

## Privacy

Delivery data — tracking numbers, descriptions, events — is personal data. The Worker does not log it, and you should not add logging that does. The default Cloudflare request log records only the method and path (`/mcp`).

## Deploy your own

Prerequisites: a Cloudflare account, a domain on Cloudflare, a Parcel API key ([Parcel's API docs](https://parcelapp.net/help/api-view-deliveries.html)), and Node.js 22.13+.

```sh
npm install
npm test            # 14 offline tests, no network or credentials needed
```

1. **Create the KV namespace** for the throttle and put its id in `wrangler.json`:

   ```sh
   npx wrangler kv namespace create RATE_LIMIT
   # paste the returned id into wrangler.json → kv_namespaces[0].id
   ```

2. **Set the Parcel secret and deploy.**

   ```sh
   npx wrangler secret put PARCEL_API_KEY
   npx wrangler deploy
   ```

3. **Attach a hostname** (Workers & Pages → your worker → Settings → Domains & Routes → add a custom domain on your zone, e.g. `parcel.example.com`). The config sets `workers_dev: false` so the Worker is reachable only there.
4. **Protect that hostname with a Cloudflare Access application** (Zero Trust → Access → Applications → Add a *self-hosted* application):
   - Set the application domain to your hostname.
   - Add a policy for the humans who may connect (e.g. *Allow* by email, with One-time PIN or your IdP).
   - Under **Advanced settings**, turn on **Managed OAuth** so non-browser MCP clients can sign in. Add your clients' OAuth redirect URIs (ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect`; claude.ai: `https://claude.ai/api/mcp/auth_callback`).
   - Copy the application's **AUD tag**.
5. **Set the Access variables** on the Worker (Settings → Variables and Secrets, type *Text*). `wrangler.json` sets `keep_vars` so later deploys preserve them and nothing deployment-specific lives in this repo:
   - `ACCESS_TEAM_DOMAIN` — your `*.cloudflareaccess.com` team domain.
   - `ACCESS_AUD` — the AUD tag from step 4.
6. **For unattended clients**, create an Access **service token** and add a **Service Auth** policy to the application that allows it. The client sends `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers.

### Deploying from GitHub

`.github/workflows/deploy.yml` deploys on every push to `main` with Cloudflare's [wrangler-action](https://github.com/cloudflare/wrangler-action). It needs, in the repository's `default-branch` environment: the secret `CLOUDFLARE_API_TOKEN` (an API token with *Workers Scripts: Edit* on your account) and the variables `CLOUDFLARE_ACCOUNT_ID` and `RATE_LIMIT_KV_NAMESPACE_ID`. In a fork the workflow does nothing until you add your own.

## Connect a client

- **ChatGPT / Claude / other OAuth clients:** add a custom connector pointing at `https://<your-hostname>/mcp`. The client discovers Access's OAuth endpoints, opens a browser for you to log in, and connects. (Clients must support [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707) resource indicators, which Access requires; mainstream clients do.)
- **CLI (e.g. Claude Code) and agents:** point the client at the same `/mcp` URL. Browser-capable clients use the OAuth flow; headless ones use a service token's headers.

## Project layout

| Path | Role |
| --- | --- |
| `src/mcp.ts` | Transport-agnostic MCP core: protocol handling, the two tools, response filtering, key redaction, safe error classification. Dependencies (identity, fetch, clock, rate reservation) are injected. |
| `src/access.ts` | Production identity verifier: validates the Cloudflare Access JWT with [`jose`](https://github.com/panva/jose). |
| `src/rate.ts` | The KV-backed throttle. |
| `src/index.ts` | The Worker entry point; wires environment and dependencies, serves `POST /mcp`. |
| `test/` | Mock-only tests. No real Parcel key or network. |
| `wrangler.json` | Worker configuration. Generic: the KV namespace id is the only value you fill in. |

## Credits

The MCP core — the two-tool shape, response filtering, redaction, error classification, and the distributed limiter — originated in a single-owner implementation for [ChatGPT's hosted apps](https://developers.openai.com/apps-sdk/). This project reworks it into a portable Worker with pluggable authentication so any MCP client can use it. See `NOTICE` for third-party licenses.

## License

MIT — see `LICENSE`.
