import assert from "node:assert/strict";
import { test } from "vitest";
import { ADD_ENDPOINT } from "../src/mcp.ts";
import {
  ACCESS_TOKEN_TTL_SECONDS,
  CLIENT_REGISTRATION_TTL_SECONDS,
  handleWorkerRequest,
  REFRESH_GRANT_TTL_SECONDS,
  type WorkerEnv,
} from "../src/oauth.ts";
import { reserveParcelRead } from "../src/rate.ts";
import { memoryKv } from "./memory-kv.ts";

// Full OAuth and MCP HTTP flow against the worker entry, with a fake Access check and an
// in-memory KV. No network, no real Cloudflare Access, no Parcel calls except the injected fetcher.
const ORIGIN = "https://parcel.example.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://client.example.test/callback";
const ACCESS_HEADER = "Cf-Access-Jwt-Assertion";
const OWNER_SESSION = "owner-session";

const owner = { userId: "user-123", email: "owner@example.test" };

function executionContext(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as ExecutionContext;
}

function workerEnv(): WorkerEnv & { RATE_LIMIT: ReturnType<typeof memoryKv> } {
  return {
    PARCEL_API_KEY: "mock-only-api-value",
    OAUTH_KV: memoryKv() as unknown as KVNamespace,
    PUBLIC_RATE_LIMIT: { limit: async () => ({ success: true }) },
    RATE_LIMIT: memoryKv(),
  };
}

function install(
  env: WorkerEnv & { RATE_LIMIT: ReturnType<typeof memoryKv> },
  fetcher: typeof fetch = () => {
    throw new Error("Network call must not occur");
  },
) {
  const verifyAccess = async (request: Request) =>
    request.headers.get(ACCESS_HEADER) === OWNER_SESSION ? owner : null;
  return (request: Request) =>
    handleWorkerRequest(request, env, executionContext(), {
      verifyAccess,
      reserve: (now) => reserveParcelRead(env.RATE_LIMIT as unknown as KVNamespace, now),
      fetcher,
    });
}

function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function pkce() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

async function register(call: (request: Request) => Promise<Response>, redirect = REDIRECT) {
  const response = await call(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Agent <script>",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
  assert.equal(response.status, 201, await response.clone().text());
  const body = (await response.json()) as { client_id: string; token_endpoint_auth_method: string };
  assert.equal(body.token_endpoint_auth_method, "none");
  assert.equal(response.headers.get(ACCESS_HEADER), null);
  return body.client_id;
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

async function consent(
  call: (request: Request) => Promise<Response>,
  clientId: string,
  challenge: string,
  session: string | null,
  decision: "approve" | "deny" = "approve",
  scope = "active_deliveries_read add_delivery",
) {
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "state-1");
  authorize.searchParams.set("resource", RESOURCE);
  if (scope) authorize.searchParams.set("scope", scope);
  const headers = new Headers();
  if (session) headers.set(ACCESS_HEADER, session);
  const page = await call(new Request(authorize, { headers }));
  if (!session) return { page, redirect: null as Response | null };
  assert.equal(page.status, 200, await page.clone().text());
  const html = await page.text();
  assert.match(page.headers.get("Content-Type") ?? "", /text\/html/);
  assert.equal(page.headers.get("Location"), null);
  assert.ok(!html.includes("code="));
  assert.ok(html.includes("Test Agent"));
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("client.example.test"));
  if (scope.includes("active_deliveries_read"))
    assert.ok(html.includes("Read active and recently completed deliveries"));
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(handle);
  const postHeaders: Record<string, string> = {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: cookieHeader(page),
  };
  if (session) postHeaders[ACCESS_HEADER] = session;
  const redirect = await call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: postHeaders,
      body: new URLSearchParams({ handle: handle ?? "", decision }),
    }),
  );
  return { page, redirect };
}

async function exchange(
  call: (request: Request) => Promise<Response>,
  clientId: string,
  code: string,
  verifier: string,
) {
  return call(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT,
        client_id: clientId,
        code_verifier: verifier,
        resource: RESOURCE,
      }),
    }),
  );
}

async function refresh(
  call: (request: Request) => Promise<Response>,
  clientId: string,
  refreshToken: string,
) {
  return call(
    new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: RESOURCE,
      }),
    }),
  );
}

type TokenBody = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
};

async function issueToken(call: (request: Request) => Promise<Response>) {
  const clientId = await register(call);
  const { verifier, challenge } = await pkce();
  const { redirect } = await consent(call, clientId, challenge, OWNER_SESSION);
  assert.equal(redirect?.status, 302);
  const location = new URL(redirect?.headers.get("Location") ?? "");
  assert.equal(location.origin + location.pathname, REDIRECT);
  assert.equal(location.searchParams.get("state"), "state-1");
  assert.equal(location.searchParams.get("iss"), ORIGIN);
  const code = location.searchParams.get("code");
  assert.ok(code);
  const wrong = await exchange(call, clientId, code ?? "", "not-the-verifier");
  assert.equal(wrong.status, 400);
  assert.equal(((await wrong.json()) as { error: string }).error, "invalid_grant");
  const { redirect: again } = await consent(call, clientId, challenge, OWNER_SESSION);
  const code2 = new URL(again?.headers.get("Location") ?? "").searchParams.get("code");
  assert.ok(code2);
  const tokenResponse = await exchange(call, clientId, code2 ?? "", verifier);
  assert.equal(tokenResponse.status, 200, await tokenResponse.clone().text());
  const token = (await tokenResponse.json()) as TokenBody;
  assert.equal(token.token_type, "bearer");
  assert.equal(token.expires_in, ACCESS_TOKEN_TTL_SECONDS);
  assert.ok(token.refresh_token);
  return { call, clientId, token };
}

function mcp(token: string, method: string, params: unknown = {}, extra: HeadersInit = {}) {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...Object.fromEntries(new Headers(extra).entries()),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

test("discovery advertises this server as the authorization server and the MCP resource", async () => {
  const call = install(workerEnv());
  const authorization = await call(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`));
  assert.equal(authorization.status, 200);
  const metadata = (await authorization.json()) as Record<string, unknown>;
  assert.equal(metadata.issuer, ORIGIN);
  assert.equal(metadata.authorization_endpoint, `${ORIGIN}/authorize`);
  assert.equal(metadata.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(metadata.registration_endpoint, `${ORIGIN}/register`);
  assert.ok((metadata.grant_types_supported as string[]).includes("authorization_code"));
  assert.ok((metadata.grant_types_supported as string[]).includes("refresh_token"));
  assert.deepEqual(metadata.code_challenge_methods_supported, ["S256"]);
  assert.ok((metadata.scopes_supported as string[]).includes("active_deliveries_read"));
  assert.ok((metadata.scopes_supported as string[]).includes("add_delivery"));

  const resource = await call(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`));
  assert.equal(resource.status, 200);
  const document = (await resource.json()) as { resource: string; authorization_servers: string[] };
  assert.equal(document.resource, RESOURCE);
  assert.deepEqual(document.authorization_servers, [ORIGIN]);
});

test("dynamic registration does not require Access and does not issue a token", async () => {
  const call = install(workerEnv());
  const response = await call(
    new Request(`${ORIGIN}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Agent",
        redirect_uris: [REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
      }),
    }),
  );
  assert.equal(response.status, 201);
  const body = (await response.json()) as { client_id?: string; access_token?: string };
  assert.ok(body.client_id);
  assert.equal(body.access_token, undefined);
});

test("authorize without a valid Access JWT does not grant", async () => {
  const call = install(workerEnv());
  const clientId = await register(call);
  const { challenge } = await pkce();
  const { page } = await consent(call, clientId, challenge, null);
  assert.equal(page.status, 401);
  const body = await page.json();
  assert.equal(body.error, "access_denied");
  assert.equal(page.headers.get("Location"), null);
  assert.equal(page.headers.get("Set-Cookie"), null);

  const posted = await call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ handle: "stolen-handle", decision: "approve" }),
    }),
  );
  assert.equal(posted.status, 401);
  assert.equal(posted.headers.get("Location"), null);
});

test("authorization code with PKCE requires the Access JWT and the consent cookie", async () => {
  const env = workerEnv();
  const call = install(env);
  const clientId = await register(call);
  const { verifier, challenge } = await pkce();
  const authorize = new URL(`${ORIGIN}/authorize`);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", REDIRECT);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("state", "state-1");
  authorize.searchParams.set("resource", RESOURCE);
  const page = await call(new Request(authorize, { headers: { [ACCESS_HEADER]: OWNER_SESSION } }));
  assert.equal(page.status, 200);
  const html = await page.text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const unbound = await call(
    new Request(`${ORIGIN}/authorize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        [ACCESS_HEADER]: OWNER_SESSION,
      },
      body: new URLSearchParams({ handle, decision: "approve" }),
    }),
  );
  assert.equal(unbound.status, 400);
  assert.equal(unbound.headers.get("Location"), null);

  const { redirect } = await consent(call, clientId, challenge, OWNER_SESSION);
  assert.equal(redirect?.status, 302);
  const location = new URL(redirect?.headers.get("Location") ?? "");
  const code = location.searchParams.get("code") ?? "";
  const wrong = await exchange(call, clientId, code, "wrong-verifier");
  assert.equal(wrong.status, 400);
  const { redirect: granted } = await consent(call, clientId, challenge, OWNER_SESSION);
  const code2 = new URL(granted?.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  const tokenResponse = await exchange(call, clientId, code2, verifier);
  const token = (await tokenResponse.json()) as TokenBody;
  assert.equal(token.expires_in, ACCESS_TOKEN_TTL_SECONDS);
  const grants = await env.OAUTH_KV.list({ prefix: "grant:" });
  assert.equal(grants.keys.length, 1);
  const grant = (await env.OAUTH_KV.get(grants.keys[0].name, { type: "json" })) as {
    expiresAt: number;
  };
  const expected = Math.floor(Date.now() / 1000) + REFRESH_GRANT_TTL_SECONDS;
  assert.ok(Math.abs(grant.expiresAt - expected) < 120);
});

test("denying consent redirects the client with access_denied and no code", async () => {
  const call = install(workerEnv());
  const clientId = await register(call);
  const { challenge } = await pkce();
  const { redirect } = await consent(call, clientId, challenge, OWNER_SESSION, "deny");
  assert.equal(redirect?.status, 302);
  const location = new URL(redirect?.headers.get("Location") ?? "");
  assert.equal(location.searchParams.get("error"), "access_denied");
  assert.equal(location.searchParams.get("code"), null);
});

test("/mcp rejects a missing, invalid, expired, or Access-only credential", async () => {
  const env = workerEnv();
  const call = install(env);
  const { token } = await issueToken(call);
  const missing = await call(
    new Request(RESOURCE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_connection_status", arguments: {} },
      }),
    }),
  );
  assert.equal(missing.status, 401);
  const challenge = missing.headers.get("WWW-Authenticate") ?? "";
  assert.match(challenge, /resource_metadata=/);
  assert.match(challenge, /oauth-protected-resource\/mcp/);

  const invalid = await call(mcp("not-a-token", "tools/call", { name: "get_connection_status" }));
  assert.equal(invalid.status, 401);
  assert.equal(((await invalid.json()) as { error: string }).error, "invalid_token");

  const accessOnly = await call(
    new Request(RESOURCE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [ACCESS_HEADER]: OWNER_SESSION,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "get_connection_status", arguments: {} },
      }),
    }),
  );
  assert.equal(accessOnly.status, 401);

  const listed = await env.OAUTH_KV.list({ prefix: "token:" });
  assert.ok(listed.keys.length > 0);
  for (const key of listed.keys) {
    const row = (await env.OAUTH_KV.get(key.name, { type: "json" })) as { expiresAt: number };
    row.expiresAt = 1;
    await env.OAUTH_KV.put(key.name, JSON.stringify(row));
  }
  const expired = await call(
    mcp(token.access_token, "tools/call", { name: "get_connection_status" }),
  );
  assert.equal(expired.status, 401);
  assert.equal(((await expired.json()) as { error: string }).error, "invalid_token");
});

test("a used refresh token is rejected once its replacement has been used", async () => {
  const env = workerEnv();
  const call = install(env);
  const { clientId, token } = await issueToken(call);
  const first = token.refresh_token;
  const rotated = await refresh(call, clientId, first);
  assert.equal(rotated.status, 200, await rotated.clone().text());
  const second = (await rotated.json()) as TokenBody;
  assert.notEqual(second.refresh_token, first);
  assert.equal(second.expires_in, ACCESS_TOKEN_TTL_SECONDS);
  const again = await refresh(call, clientId, second.refresh_token);
  assert.equal(again.status, 200);
  const third = (await again.json()) as TokenBody;
  const replay = await refresh(call, clientId, first);
  assert.equal(replay.status, 400);
  assert.equal(((await replay.json()) as { error: string }).error, "invalid_grant");
  const stillCurrent = await refresh(call, clientId, third.refresh_token);
  assert.equal(stillCurrent.status, 200);
});

test("refresh slides the 90-day idle window; idle past that is refused", async () => {
  const env = workerEnv();
  const call = install(env);
  const realNow = Date.now.bind(Date);
  let nowMs = realNow();
  Date.now = () => nowMs;
  try {
    const { clientId, token } = await issueToken(call);
    const grantKey = (await env.OAUTH_KV.list({ prefix: "grant:" })).keys[0].name;
    const initial = (await env.OAUTH_KV.get(grantKey, { type: "json" })) as {
      expiresAt: number;
    };
    const issuedAt = Math.floor(nowMs / 1000);
    assert.ok(Math.abs(initial.expiresAt - (issuedAt + REFRESH_GRANT_TTL_SECONDS)) < 5);

    // Advance well inside the window and refresh: expiry must move forward with the clock.
    nowMs += 30 * 24 * 60 * 60 * 1000;
    const rotated = await refresh(call, clientId, token.refresh_token);
    assert.equal(rotated.status, 200, await rotated.clone().text());
    const second = (await rotated.json()) as TokenBody;
    const afterRefresh = (await env.OAUTH_KV.get(grantKey, { type: "json" })) as {
      expiresAt: number;
    };
    const refreshedAt = Math.floor(nowMs / 1000);
    assert.ok(afterRefresh.expiresAt > initial.expiresAt + 29 * 24 * 60 * 60);
    assert.ok(Math.abs(afterRefresh.expiresAt - (refreshedAt + REFRESH_GRANT_TTL_SECONDS)) < 5);

    // Isolate grant idle from client registration: this jump never uses the token
    // endpoint, so the library never renews the client. Re-store it without a KV
    // expiry so the refusal below is invalid_grant from the grant, not invalid_client.
    const clientKey = `client:${clientId}`;
    const clientRecord = await env.OAUTH_KV.get(clientKey);
    assert.ok(clientRecord);
    await env.OAUTH_KV.put(clientKey, clientRecord);

    // Idle until fewer than 60s remain on the grant (library minimum KV window).
    nowMs = (afterRefresh.expiresAt - 30) * 1000;
    const idle = await refresh(call, clientId, second.refresh_token);
    assert.equal(idle.status, 400, await idle.clone().text());
    assert.equal(((await idle.json()) as { error: string }).error, "invalid_grant");
  } finally {
    Date.now = realNow;
  }
});

test("regular refresh renews the client past the original registration expiry", async () => {
  const env = workerEnv();
  const call = install(env);
  const realNow = Date.now.bind(Date);
  let nowMs = realNow();
  Date.now = () => nowMs;
  try {
    const { clientId, token } = await issueToken(call);
    const clientKey = `client:${clientId}`;
    const initial = (await env.OAUTH_KV.get(clientKey, { type: "json" })) as {
      registrationExpiresAt: number;
    };
    const registeredAt = Math.floor(nowMs / 1000);
    assert.ok(
      Math.abs(initial.registrationExpiresAt - (registeredAt + CLIENT_REGISTRATION_TTL_SECONDS)) <
        5,
    );

    // Past half the registration window: a successful refresh must renew the client.
    nowMs += 50 * 24 * 60 * 60 * 1000;
    const mid = await refresh(call, clientId, token.refresh_token);
    assert.equal(mid.status, 200, await mid.clone().text());
    const midBody = (await mid.json()) as TokenBody;
    const renewed = (await env.OAUTH_KV.get(clientKey, { type: "json" })) as {
      registrationExpiresAt: number;
    };
    const renewedAt = Math.floor(nowMs / 1000);
    assert.ok(renewed.registrationExpiresAt > initial.registrationExpiresAt);
    assert.ok(
      Math.abs(renewed.registrationExpiresAt - (renewedAt + CLIENT_REGISTRATION_TTL_SECONDS)) < 5,
    );

    // Past the original registration expiry; with renewal, refresh still succeeds.
    nowMs = (registeredAt + CLIENT_REGISTRATION_TTL_SECONDS + 24 * 60 * 60) * 1000;
    const later = await refresh(call, clientId, midBody.refresh_token);
    assert.equal(later.status, 200, await later.clone().text());
  } finally {
    Date.now = realNow;
  }
});

test("a token without add_delivery cannot add, and can still read", async () => {
  const call = install(workerEnv(), async () =>
    Response.json({
      success: true,
      deliveries: [{ status_code: 0, events: [] }],
    }),
  );
  const clientId = await register(call);
  const { verifier, challenge } = await pkce();
  const { redirect } = await consent(
    call,
    clientId,
    challenge,
    OWNER_SESSION,
    "approve",
    "active_deliveries_read",
  );
  const code = new URL(redirect?.headers.get("Location") ?? "").searchParams.get("code") ?? "";
  const token = (await (await exchange(call, clientId, code, verifier)).json()) as TokenBody;
  const status = await call(
    mcp(token.access_token, "tools/call", { name: "get_connection_status", arguments: {} }),
  );
  assert.equal(status.status, 200);
  const listed = await call(
    mcp(token.access_token, "tools/call", { name: "list_deliveries", arguments: {} }),
  );
  const result = JSON.parse((await listed.json()).result.content[0].text);
  assert.equal(result.filter_mode, "recent");
  assert.equal(result.deliveries[0].status_label, "completed");
  const added = await call(
    mcp(token.access_token, "tools/call", {
      name: "add_delivery",
      arguments: {
        tracking_number: "1Z999AA10123456784",
        carrier_code: "ups",
        description: "Test package",
      },
    }),
  );
  assert.equal(added.status, 403);
  assert.match(added.headers.get("WWW-Authenticate") ?? "", /insufficient_scope/);
});

test("tools run with a worker-issued access token and report the approving identity", async () => {
  let upstream: { url?: unknown; body?: string } = {};
  const fetcher = (async (url: unknown, init?: RequestInit) => {
    upstream = { url, body: typeof init?.body === "string" ? init.body : undefined };
    if (url === ADD_ENDPOINT) return Response.json({ success: true });
    return Response.json({
      success: true,
      deliveries: [{ carrier_code: "ups", description: "Box", tracking_number: "1Z", events: [] }],
    });
  }) as typeof fetch;
  const call = install(workerEnv(), fetcher);
  const { token } = await issueToken(call);

  const status = await call(
    mcp(
      token.access_token,
      "tools/call",
      { name: "get_connection_status", arguments: {} },
      {
        [ACCESS_HEADER]: "not-consulted",
      },
    ),
  );
  assert.equal(status.status, 200);
  const statusBody = JSON.parse((await status.json()).result.content[0].text);
  assert.equal(statusBody.authenticated, true);
  assert.equal(statusBody.authenticated_user_id, owner.userId);
  assert.equal(statusBody.authenticated_user_email, owner.email);
  assert.equal(statusBody.secret_configured, true);
  assert.ok(!JSON.stringify(statusBody).includes("mock-only-api-value"));

  const listed = await call(
    mcp(token.access_token, "tools/call", { name: "list_deliveries", arguments: {} }),
  );
  assert.equal(listed.status, 200);
  const deliveries = JSON.parse((await listed.json()).result.content[0].text);
  assert.equal(deliveries.deliveries[0].tracking_number, "1Z");

  const added = await call(
    mcp(token.access_token, "tools/call", {
      name: "add_delivery",
      arguments: {
        tracking_number: "1Z999AA10123456784",
        carrier_code: "ups",
        description: "Test package",
      },
    }),
  );
  assert.equal(added.status, 200);
  const addedBody = JSON.parse((await added.json()).result.content[0].text);
  assert.equal(addedBody.added, true);
  assert.equal(upstream.url, ADD_ENDPOINT);
});

test("public request limits refuse excess requests and fail closed when unavailable", async () => {
  for (const [limiter, status] of [
    [{ limit: async () => ({ success: false }) }, 429],
    [undefined, 503],
    [
      {
        limit: async () => {
          throw new Error("unavailable");
        },
      },
      503,
    ],
  ] as const) {
    const env = workerEnv();
    env.PUBLIC_RATE_LIMIT = limiter;
    const response = await install(env)(
      new Request(`${ORIGIN}/.well-known/oauth-authorization-server`),
    );
    assert.equal(response.status, status);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    if (status === 429) assert.equal(response.headers.get("Retry-After"), "60");
  }
});

test("token and consent bodies are bounded even without Content-Length", async () => {
  for (const path of ["/oauth/token", "/authorize"]) {
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(32_768));
        controller.enqueue(new Uint8Array(32_769));
        controller.close();
      },
    });
    const request = new Request(`${ORIGIN}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      duplex: "half",
    } as RequestInit);
    const response = await install(workerEnv())(request);
    assert.equal(response.status, 413);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
  }
});
