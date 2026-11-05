import assert from "node:assert/strict";
import { test } from "vitest";
import { ADD_ENDPOINT, handleMcp, MIN_INTERVAL_MS } from "../src/mcp.ts";

// Identity is supplied by an injected verifier (production: a Cloudflare Access JWT check). These
// tests inject mock verifiers and mock fetch/reserve; no real network or real Access is involved.
const configured = { PARCEL_API_KEY: "mock-only-api-value" };
const okIdentity = async () => ({ userId: "user-123", email: "owner@example.test" });
const serviceTokenIdentity = async () => ({ userId: "svc.token.client-id", email: null });
const noIdentity = async () => null;
const noNetwork = () => {
  throw new Error("Network call must not occur");
};

function request(method, params = {}) {
  return new Request("https://parcel.example.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}
const call = (name, args) => request("tools/call", { name, arguments: args ?? {} });
const decode = async (r) => JSON.parse((await r.json()).result.content[0].text);

test("discovery is private-data-free and exposes two read-only tools plus add_delivery", async () => {
  const r = await handleMcp(request("tools/list", {}), configured, {
    verifyIdentity: noIdentity,
    fetcher: noNetwork,
  });
  const body = await r.json();
  assert.deepEqual(
    body.result.tools.map((t) => t.name),
    ["get_connection_status", "list_active_deliveries", "add_delivery"],
  );
  assert.ok(body.result.tools.every((t) => !t.annotations.destructiveHint));
  assert.ok(
    body.result.tools
      .filter((t) => t.name !== "add_delivery")
      .every((t) => t.annotations.readOnlyHint),
  );
  assert.ok(!JSON.stringify(body).includes(configured.PARCEL_API_KEY));
});

const addArgs = {
  tracking_number: "1Z999AA10123456784",
  carrier_code: "ups",
  description: "Test package",
};

test("add_delivery posts exactly the validated fields to Parcel and reports success", async () => {
  let seen: { url: unknown; init: RequestInit | undefined } | undefined;
  const fetcher = async (url: unknown, init?: RequestInit) => {
    seen = { url, init };
    return Response.json({ success: true });
  };
  const r = await handleMcp(call("add_delivery", addArgs), configured, {
    verifyIdentity: okIdentity,
    fetcher,
  });
  assert.deepEqual(await decode(r), {
    added: true,
    ...addArgs,
    note: "Parcel will populate tracking data on its next update.",
  });
  assert.equal(seen?.url, ADD_ENDPOINT);
  assert.equal(seen?.init?.method, "POST");
  const headers = (seen?.init?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["api-key"], configured.PARCEL_API_KEY);
  assert.deepEqual(JSON.parse(String(seen?.init?.body)), addArgs);
});

test("add_delivery rejects missing, oversized, extra, or malformed arguments before any network call", async () => {
  for (const args of [
    {},
    { ...addArgs, description: undefined },
    { ...addArgs, tracking_number: "x".repeat(101) },
    { ...addArgs, carrier_code: "ups; drop" },
    { ...addArgs, bogus: "field" },
    { ...addArgs, postcode: 42 },
  ]) {
    const r = await handleMcp(call("add_delivery", args), configured, {
      verifyIdentity: okIdentity,
      fetcher: noNetwork,
    });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).error.code, -32602, JSON.stringify(args));
  }
});

test("add_delivery requires identity and a configured secret", async () => {
  const anon = await handleMcp(call("add_delivery", addArgs), configured, {
    verifyIdentity: noIdentity,
    fetcher: noNetwork,
  });
  assert.equal(anon.status, 401);
  const noSecret = await handleMcp(
    call("add_delivery", addArgs),
    {},
    { verifyIdentity: okIdentity, fetcher: noNetwork },
  );
  assert.equal((await noSecret.json()).result.isError, true);
});

test("add_delivery surfaces Parcel errors with the key redacted and maps the daily limit", async () => {
  const leaky = async () =>
    Response.json({
      success: false,
      error_message: `bad number for key ${configured.PARCEL_API_KEY}`,
    });
  const r = await handleMcp(call("add_delivery", addArgs), configured, {
    verifyIdentity: okIdentity,
    fetcher: leaky,
  });
  const body = await decode(r);
  assert.equal(body.error_code, "UPSTREAM_REPORTED_ERROR");
  assert.ok(body.error.includes("[redacted]") && !body.error.includes(configured.PARCEL_API_KEY));
  const limited = async () => new Response("", { status: 429 });
  const l = await decode(
    await handleMcp(call("add_delivery", addArgs), configured, {
      verifyIdentity: okIdentity,
      fetcher: limited,
    }),
  );
  assert.equal(l.error_code, "UPSTREAM_RATE_LIMITED");
  const down = async () => {
    throw new TypeError("fetch failed");
  };
  const d = await decode(
    await handleMcp(call("add_delivery", addArgs), configured, {
      verifyIdentity: okIdentity,
      fetcher: down,
    }),
  );
  assert.equal(d.error_code, "UPSTREAM_FETCH_TYPE_ERROR");
});

test("initialization negotiates a supported protocol", async () => {
  const r = await handleMcp(request("initialize", { protocolVersion: "2024-11-05" }), {});
  assert.equal((await r.json()).result.protocolVersion, "2024-11-05");
});

test("data calls without a verified identity are rejected", async () => {
  const r = await handleMcp(call("list_active_deliveries"), configured, {
    verifyIdentity: noIdentity,
    fetcher: noNetwork,
  });
  assert.equal(r.status, 401);
});

test("a misconfigured server with no verifier fails closed", async () => {
  // index.ts leaves verifyIdentity undefined when ACCESS_* vars are missing; that must deny, not allow.
  const r = await handleMcp(call("list_active_deliveries"), configured, { fetcher: noNetwork });
  assert.equal(r.status, 401);
});

test("a verified service token (no email) is authorized like a user", async () => {
  const r = await handleMcp(call("get_connection_status"), configured, {
    verifyIdentity: serviceTokenIdentity,
  });
  const status = JSON.parse((await r.json()).result.content[0].text);
  assert.equal(status.authenticated, true);
  assert.equal(status.authenticated_user_id, "svc.token.client-id");
  assert.equal(status.authenticated_user_email, null);
});

test("missing secret or missing limiter each fail closed", async () => {
  const noSecret = await handleMcp(
    call("list_active_deliveries"),
    {},
    { verifyIdentity: okIdentity, reserve: async () => null, fetcher: noNetwork },
  );
  assert.equal((await noSecret.json()).result.isError, true);
  const noLimiter = await handleMcp(call("list_active_deliveries"), configured, {
    verifyIdentity: okIdentity,
    fetcher: noNetwork,
  });
  assert.equal((await noLimiter.json()).result.isError, true);
});

test("status returns identity and booleans only, never the key", async () => {
  const r = await handleMcp(call("get_connection_status"), configured, {
    verifyIdentity: okIdentity,
  });
  const text = await r.text();
  assert.ok(!text.includes(configured.PARCEL_API_KEY));
  const status = JSON.parse(JSON.parse(text).result.content[0].text);
  assert.equal(status.authenticated, true);
  assert.equal(status.authenticated_user_id, "user-123");
  assert.equal(status.secret_configured, true);
});

test("nonempty tool args and mutation names are rejected before any work", async () => {
  for (const [name, args] of [
    ["list_active_deliveries", { filter_mode: "recent" }],
    ["add_delivery", {}],
  ]) {
    const r = await handleMcp(call(name, args), configured, {
      verifyIdentity: okIdentity,
      fetcher: noNetwork,
    });
    assert.equal((await r.json()).error.code, -32602);
  }
});

test("fixed GET endpoint, no redirects, sanitized fields and no-store", async () => {
  let calls = 0;
  const r = await handleMcp(call("list_active_deliveries"), configured, {
    verifyIdentity: okIdentity,
    now: () => 0,
    reserve: async () => null,
    fetcher: async (url, opts) => {
      calls++;
      assert.equal(url, "https://api.parcel.app/external/deliveries/?filter_mode=active");
      assert.equal(opts.method, "GET");
      assert.equal(opts.redirect, "manual");
      assert.equal(opts.headers["api-key"], configured.PARCEL_API_KEY);
      return Response.json({
        success: true,
        deliveries: [
          {
            carrier_code: "mock",
            description: "Test mock-only-api-value",
            tracking_number: "123",
            status_code: 2,
            extra_information: "private@example.test",
            events: [],
          },
        ],
      });
    },
  });
  assert.equal(calls, 1);
  assert.match(r.headers.get("Cache-Control"), /no-store/);
  const data = await decode(r);
  assert.equal(data.deliveries[0].description, "Test [redacted]");
  assert.ok(!("extra_information" in data.deliveries[0]));
  assert.equal(data.filter_mode, "active");
});

test("rate-limited calls do not contact Parcel", async () => {
  const r = await handleMcp(call("list_active_deliveries"), configured, {
    verifyIdentity: okIdentity,
    now: () => 0,
    reserve: async () => MIN_INTERVAL_MS,
    fetcher: noNetwork,
  });
  const data = await decode(r);
  assert.equal(data.retry_at, new Date(MIN_INTERVAL_MS).toISOString());
});

test("upstream errors never echo server data or secrets", async () => {
  for (const status of [401, 429, 500]) {
    const r = await handleMcp(call("list_active_deliveries"), configured, {
      verifyIdentity: okIdentity,
      reserve: async () => null,
      fetcher: async () => new Response("mock-only-api-value", { status }),
    });
    const text = await r.text();
    assert.ok(!text.includes("mock-only-api-value"));
    assert.ok(JSON.parse(text).result.isError);
  }
});

test("cross-origin browser calls are rejected", async () => {
  const r = call("list_active_deliveries");
  r.headers.set("Origin", "https://other.example.test");
  assert.equal(
    (await handleMcp(r, configured, { verifyIdentity: okIdentity, fetcher: noNetwork })).status,
    403,
  );
});

test("large bodies and invalid upstream payloads fail safely", async () => {
  const huge = new Request("https://parcel.example.test/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "x".repeat(9000),
  });
  assert.equal((await handleMcp(huge, configured, { verifyIdentity: okIdentity })).status, 400);
  const r = await handleMcp(call("list_active_deliveries"), configured, {
    verifyIdentity: okIdentity,
    reserve: async () => null,
    fetcher: async () =>
      Response.json({ success: false, error_message: configured.PARCEL_API_KEY }),
  });
  const text = await r.text();
  assert.ok(!text.includes(configured.PARCEL_API_KEY));
  assert.ok(JSON.parse(text).result.isError);
});

test("diagnostics distinguish failures without echoing exception or response contents", async () => {
  for (const [fetcher, code] of [
    [
      async () => {
        throw new TypeError("mock-only-api-value transport failure");
      },
      "UPSTREAM_FETCH_TYPE_ERROR",
    ],
    [
      async () =>
        new Response("<html>mock-only-api-value</html>", {
          headers: { "Content-Type": "text/html" },
        }),
      "UPSTREAM_INVALID_JSON",
    ],
    [
      async () =>
        new Response("", {
          status: 302,
          headers: { Location: "https://untrusted.example/mock-only-api-value" },
        }),
      "UPSTREAM_REDIRECT_REJECTED",
    ],
    [
      async () => Response.json({ success: false, error_message: "mock-only-api-value" }),
      "UPSTREAM_REPORTED_ERROR",
    ],
  ]) {
    const r = await handleMcp(call("list_active_deliveries"), configured, {
      verifyIdentity: okIdentity,
      reserve: async () => null,
      fetcher,
    });
    const body = await decode(r);
    assert.equal(body.error_code, code);
    assert.ok(!JSON.stringify(body).includes(configured.PARCEL_API_KEY));
  }
});
