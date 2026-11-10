import { createAccessVerifier } from "./access.ts";
import { handleWorkerRequest, type WorkerEnv } from "./oauth.ts";
import { reserveParcelRead } from "./rate.ts";

// Cloudflare Worker entry point. The Worker is its own OAuth 2.1 authorization server.
// /mcp accepts only access tokens this Worker issued. Cloudflare Access is checked only
// when the owner approves a grant at /authorize. Deployment-specific values (team domain,
// audience, hostname, namespace ids) come from the environment and are not compiled in.

export interface Env extends WorkerEnv {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  RATE_LIMIT?: KVNamespace;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const verifyAccess =
      env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD
        ? createAccessVerifier({ teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD })
        : async () => null;
    return handleWorkerRequest(request, env, ctx, {
      verifyAccess,
      reserve: (now) => reserveParcelRead(env.RATE_LIMIT, now),
    });
  },
};
