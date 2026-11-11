// OAuth 2.1 authorization server and resource server for the Parcel MCP endpoint.
//
// @cloudflare/workers-oauth-provider issues the tokens, stores clients and grants in the
// OAUTH_KV binding, and publishes the MCP discovery documents. This module owns the two
// decisions the library leaves to the application: who may approve a grant, and how an
// approved grant is presented to the Parcel tools.
//
// The issuer and the protected-resource URL are taken from the request origin. Nothing
// deployment-specific is compiled in. That is safe only while the Worker is served on one
// public hostname (workers_dev stays off). A second route would be a second issuer.

import {
  AuthorizationError,
  authorizationErrorRedirect,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
  OAuthProvider,
  type OAuthResourceAuth,
} from "@cloudflare/workers-oauth-provider";
import { boundedBody } from "./body.ts";
import type { Identity } from "./mcp.ts";
import { handleMcp } from "./mcp.ts";

/** Access tokens are short. Clients refresh them. */
export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/**
 * How long a refresh grant stays valid after it is issued or last successfully refreshed.
 * Passed as both the initial grant lifetime and the sliding idle lifetime, so a grant
 * expires only after this long without a successful refresh. Regular use never expires it.
 */
export const REFRESH_GRANT_TTL_SECONDS = 90 * 24 * 60 * 60;

/**
 * How long a dynamically registered client record lasts. The library renews it on a
 * successful token response once past half this window, so an agent that keeps
 * refreshing is never cut off by registration expiry. Leaving this unset would use
 * the same library default; it is set here so the renewal contract is explicit.
 * Unused grants still end at REFRESH_GRANT_TTL_SECONDS of idle.
 */
export const CLIENT_REGISTRATION_TTL_SECONDS = 90 * 24 * 60 * 60;

export const OAUTH_SCOPES = ["active_deliveries_read", "add_delivery"] as const;

export interface WorkerEnv {
  PARCEL_API_KEY?: string;
  OAUTH_KV?: KVNamespace;
  PUBLIC_RATE_LIMIT?: Cloudflare.Env["PUBLIC_RATE_LIMIT"];
  /** Injected by the provider before it calls a handler. */
  OAUTH_PROVIDER?: OAuthHelpers;
}

export type WorkerDependencies = {
  /** Cloudflare Access JWT check. Used only while approving a grant. */
  verifyAccess: (request: Request) => Promise<Identity | null>;
  reserve?: (now: number) => Promise<number | null>;
  fetcher?: typeof fetch;
  now?: () => number;
};

const noStore = { "Cache-Control": "no-store" };
const textHeaders = { ...noStore, "Content-Type": "text/plain; charset=utf-8" };

type AuthedContext = ExecutionContext & {
  props?: { userId?: unknown; email?: unknown };
  auth?: OAuthResourceAuth;
};

export async function handleWorkerRequest(
  request: Request,
  env: WorkerEnv,
  ctx: ExecutionContext,
  deps: WorkerDependencies,
): Promise<Response> {
  // Cloudflare supplies this header. Unauthenticated endpoints have no stable user ID yet.
  try {
    if (!env.PUBLIC_RATE_LIMIT) return plain("Request limiter unavailable.", 503);
    const { success } = await env.PUBLIC_RATE_LIMIT.limit({
      key: `parcel-mcp:${request.headers.get("CF-Connecting-IP") ?? "unknown"}`,
    });
    if (!success)
      return new Response("Too many requests.", {
        status: 429,
        headers: { ...textHeaders, "Retry-After": "60" },
      });
  } catch {
    return plain("Request limiter unavailable.", 503);
  }
  const pathname = new URL(request.url).pathname;
  if (request.method === "POST" && (pathname === "/oauth/token" || pathname === "/authorize")) {
    try {
      request = new Request(request, { body: await boundedBody(request, 65_536) });
    } catch {
      return plain("Invalid or oversized form body.", 413);
    }
  }
  const target = publicResource(request);
  if (!target) return plain("The request origin is not a valid OAuth issuer.", 400);
  // OAuthProvider validates its options at construction. A TypeError here is a server
  // misconfiguration, not a bad client request — leave it uncaught so the Worker logs
  // and returns 500 instead of blaming the client with 400.
  const provider = createProvider(target, deps);
  return provider.fetch(request, env, ctx);
}

function createProvider(
  target: { origin: string; resource: string },
  deps: WorkerDependencies,
): OAuthProvider<WorkerEnv> {
  return new OAuthProvider<WorkerEnv>({
    apiRoute: "/mcp",
    apiHandler: {
      fetch: (request, env, ctx) =>
        handleAuthenticatedMcp(request, env, ctx as AuthedContext, deps),
    },
    defaultHandler: {
      fetch: (request, env) => handlePublic(request, env, deps.verifyAccess),
    },
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/oauth/token",
    clientRegistrationEndpoint: "/register",
    scopesSupported: [...OAUTH_SCOPES],
    requiredScopes: [...OAUTH_SCOPES],
    accessTokenTTL: ACCESS_TOKEN_TTL_SECONDS,
    // Same constant for both: a new grant lasts this long, and every successful
    // refresh moves the expiry that far out again.
    refreshTokenTTL: REFRESH_GRANT_TTL_SECONDS,
    refreshTokenIdleTTL: REFRESH_GRANT_TTL_SECONDS,
    clientRegistrationTTL: CLIENT_REGISTRATION_TTL_SECONDS,
    allowPrivateUseRedirectUris: true,
    clientIdMetadataDocumentEnabled: true,
    resourceMetadata: {
      resource: target.resource,
      authorization_servers: [target.origin],
      bearer_methods_supported: ["header"],
      resource_name: "Parcel",
    },
    onError({ code, status }) {
      console.warn(JSON.stringify({ source: "parcel-mcp-oauth", status, code }));
    },
  });
}

async function handlePublic(
  request: Request,
  env: WorkerEnv,
  verifyAccess: WorkerDependencies["verifyAccess"],
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname !== "/authorize") return new Response(null, { status: 404, headers: noStore });
  return handleAuthorize(request, env, verifyAccess);
}

/**
 * Access proves the caller is the owner. The consent page is the grant: it names the
 * client and where the tokens will be sent, and nothing is issued until Allow is posted
 * back with the browser-bound handle. A link alone must not mint a refresh token.
 */
async function handleAuthorize(
  request: Request,
  env: WorkerEnv,
  verifyAccess: WorkerDependencies["verifyAccess"],
): Promise<Response> {
  const identity = await verifyAccess(request);
  if (!identity) {
    return Response.json(
      {
        error: "access_denied",
        error_description: "Cloudflare Access authentication is required.",
      },
      { status: 401, headers: noStore },
    );
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...noStore, Allow: "GET, POST" } });
  }
  const oauth = env.OAUTH_PROVIDER;
  if (!oauth) return plain("Authorization server is unavailable.", 500);
  try {
    return request.method === "POST"
      ? await submitConsent(request, oauth, identity)
      : await showConsent(request, oauth);
  } catch (error) {
    return authorizationFailure(error);
  }
}

async function showConsent(request: Request, oauth: OAuthHelpers): Promise<Response> {
  const authRequest = await oauth.parseAuthRequest(request);
  const scope = scopesToGrant(authRequest.scope);
  if (!scope) {
    return Response.redirect(
      authorizationErrorRedirect(authRequest, "invalid_scope", "Unknown scope"),
      302,
    );
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("X-Content-Type-Options", "nosniff");
  return new Response(consentPage(details, consent.handle, scope), {
    status: 200,
    headers: consent.headers,
  });
}

async function submitConsent(
  request: Request,
  oauth: OAuthHelpers,
  identity: Identity,
): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return plain("The approval form was not valid.", 400);
  }
  const handle = form.get("handle");
  if (typeof handle !== "string" || !handle) return plain("Missing authorization handle.", 400);
  if (form.get("decision") !== "approve") {
    const denied = await oauth.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await oauth.approveConsent(request, handle);
  const scope = scopesToGrant(approved.request.scope);
  if (!scope) return plain("Unknown scope.", 400);
  const { redirectTo } = await oauth.completeAuthorization({
    request: approved.request,
    userId: storageUserId(identity.userId),
    metadata: {},
    scope,
    props: { userId: identity.userId, email: identity.email },
  });
  approved.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: approved.headers });
}

function authorizationFailure(error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) {
    return Response.redirect(error.redirectTo, 302);
  }
  if (error instanceof AuthorizationError) return plain(error.description, 400);
  if (error instanceof CimdFetchError) return plain("This app could not be verified.", 400);
  throw error;
}

function consentPage(
  details: ConsentDescription,
  handle: string,
  scope: readonly string[],
): string {
  const name = escapeHtml(details.clientName);
  const host = escapeHtml(details.redirectHost);
  const published = details.clientDomain
    ? `Published by ${escapeHtml(details.clientDomain)}.`
    : "This app registered itself; its name is not verified.";
  const scopes = scope.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<title>Authorize ${name}</title>
<h1>Allow ${name} to use Parcel?</h1>
<p>${published} Tokens will be sent to <strong>${host}</strong>.</p>
${loopback}
<p>Allowing this grants the Parcel account configured on this server.</p>
<ul>${scopes}</ul>
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button name="decision" value="approve">Allow</button>
<button name="decision" value="deny">Deny</button>
</form>`;
}

async function handleAuthenticatedMcp(
  request: Request,
  env: WorkerEnv,
  ctx: AuthedContext,
  deps: WorkerDependencies,
): Promise<Response> {
  const identity = identityFrom(ctx.props);
  if (!identity || !ctx.auth) return plain("Authentication required.", 401);
  // Scope is checked inside handleMcp against the same request parse that names the tool.
  return handleMcp(
    request,
    { PARCEL_API_KEY: env.PARCEL_API_KEY },
    {
      identity,
      authorizedScopes: ctx.auth.scope,
      reserve: deps.reserve,
      fetcher: deps.fetcher,
      now: deps.now,
    },
  );
}

function identityFrom(props: AuthedContext["props"]): Identity | null {
  if (!props || typeof props.userId !== "string" || !props.userId) return null;
  return { userId: props.userId, email: typeof props.email === "string" ? props.email : null };
}

/** Scopes the grant will actually carry. Empty request means the server's full set. */
export function scopesToGrant(requested: readonly string[]): string[] | null {
  if (requested.length === 0) return [...OAUTH_SCOPES];
  const supported = new Set<string>(OAUTH_SCOPES);
  const picked = requested.filter((scope) => supported.has(scope));
  return picked.length > 0 ? picked : null;
}

/**
 * The provider's token format reserves `:`. Access subjects are usually UUIDs; encode
 * anything else so the raw id can still be stored in the encrypted props.
 */
function storageUserId(userId: string): string {
  return userId.includes(":") ? encodeURIComponent(userId) : userId;
}

function publicResource(request: Request): { origin: string; resource: string } | null {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password) return null;
  return { origin: url.origin, resource: `${url.origin}/mcp` };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function plain(message: string, status: number): Response {
  return new Response(message, { status, headers: textHeaders });
}
