import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Identity } from "./mcp.ts";

// Verifies the identity that Cloudflare Access asserts for an incoming request.
//
// When a request reaches the origin through Access — whether the client authenticated via Managed
// OAuth (a human login) or a service token (a machine) — Access injects a signed JWT in the
// `Cf-Access-Jwt-Assertion` header. We verify that JWT against the team's public keys, checking the
// signature, the issuer (the team domain) and the audience (this application's AUD tag). A forged or
// client-supplied header cannot pass, because the client does not hold Access's signing key — so this
// check is the real protection even if the Worker is reached directly, not only a convenience.
//
// A verified user login carries `sub` (a stable user id) and `email`. A verified service token carries
// `common_name` (the token's client id) and no email. Either is a valid, authorized identity: the
// Access policy already decided who is allowed to reach this application.

export type AccessConfig = { teamDomain: string; aud: string };

type Verifier = (request: Request) => Promise<Identity | null>;

// Builds the production verifier. `teamDomain` is the full Access hostname, e.g.
// "your-team.cloudflareaccess.com"; `aud` is the Application Audience (AUD) tag of the Access app.
// The JWKS is fetched once and cached/refreshed by jose.
export function createAccessVerifier({ teamDomain, aud }: AccessConfig): Verifier {
  const issuer = `https://${teamDomain}`;
  const JWKS = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async (request: Request): Promise<Identity | null> => {
    const token = request.headers.get("Cf-Access-Jwt-Assertion");
    if (!token) return null;
    try {
      const { payload } = await jwtVerify(token, JWKS, { issuer, audience: aud });
      const userId =
        (typeof payload.sub === "string" && payload.sub) ||
        (typeof payload.common_name === "string" && payload.common_name) ||
        null;
      if (!userId) return null;
      const email = typeof payload.email === "string" ? payload.email : null;
      return { userId, email };
    } catch {
      return null;
    }
  };
}
