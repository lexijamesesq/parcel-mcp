import { createAccessVerifier } from "./access.ts";
import { type Config, handleMcp } from "./mcp.ts";
import { reserveParcelRead } from "./rate.ts";

// Cloudflare Worker entry point. Wires production dependencies to the transport-agnostic core and
// serves the MCP endpoint at POST /mcp. All deployment-specific values come from the environment:
// nothing about any particular deployment (team domain, audience, hostname) is baked into the code.

export interface Env {
  PARCEL_API_KEY?: string; // secret: the Parcel account's API key
  ACCESS_TEAM_DOMAIN?: string; // var: e.g. "your-team.cloudflareaccess.com"
  ACCESS_AUD?: string; // var: the Access application's AUD tag
  RATE_LIMIT?: KVNamespace; // binding: holds the shared throttle key
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/mcp")
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } });
    if (request.method !== "POST")
      return new Response(null, {
        status: 405,
        headers: { Allow: "POST", "Cache-Control": "no-store" },
      });

    const config: Config = { PARCEL_API_KEY: env.PARCEL_API_KEY };
    const verifyIdentity =
      env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD
        ? createAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD })
        : undefined; // misconfiguration => no verifier => every data call fails closed with 401

    return handleMcp(request, config, {
      verifyIdentity,
      reserve: (now) => reserveParcelRead(env.RATE_LIMIT, now),
    });
  },
};
