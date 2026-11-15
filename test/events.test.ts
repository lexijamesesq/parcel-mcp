import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test, vi } from "vitest";
import { type EventStorage, EventSubscriptions, sendCallback } from "../src/events.ts";
import { handleMcp, toolResult } from "../src/mcp.ts";

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const OWNER = {
  userId: "owner",
  clientId: "client",
  grantId: "grant",
  resource: "https://parcel.example.test/mcp",
};
const PARAMS = {
  name: "notifications.test",
  arguments: { test_id: "wake-acceptance" },
  delivery: { mode: "webhook", url: "https://receiver.example.test/events", secret: SECRET },
};

function fixture() {
  let now = 1_800_000_000_000;
  const saved = new Map<string, unknown>();
  let alarm: number | null = null;
  let authorized = true;
  let status = 200;
  let challengeValid = true;
  let reads = 0;
  let stale = false;
  let authorizationDelay = 0;
  let snapshot = { fetched_at: new Date(now).toISOString(), deliveries: [], stale: false };
  const received: { headers: Headers; body: Record<string, unknown>; raw: string }[] = [];
  // Only storage and network are substituted; the real MCP/event handlers own all behavior.
  const transaction = {
    put: async (key, value) => {
      saved.set(key, structuredClone(value));
    },
    setAlarm: async (time) => {
      alarm = time;
    },
    deleteAlarm: async () => {
      alarm = null;
    },
  };
  const storage = {
    get: async (key) => structuredClone(saved.get(key)),
    transaction: async (callback) => callback(transaction),
  } as EventStorage;
  const deps = {
    storage,
    random: () => 0,
    read: async () => {
      reads++;
      return toolResult({
        ...snapshot,
        fetched_at: stale ? snapshot.fetched_at : new Date(now).toISOString(),
        stale,
      });
    },
    now: () => now,
    authorized: async () => {
      now += authorizationDelay;
      return authorized;
    },
    send: async (_url, headers, raw) => {
      const body = JSON.parse(raw);
      received.push({ headers: new Headers(headers), body, raw });
      return body.type === "verification"
        ? Response.json({ challenge: challengeValid ? body.challenge : "wrong" })
        : new Response(null, { status });
    },
  };
  let service = new EventSubscriptions(deps);
  return {
    received,
    get reads() {
      return reads;
    },
    stale: (value) => {
      stale = value;
    },
    delayAuthorization: (ms) => {
      authorizationDelay = ms;
    },
    snapshot: (deliveries) => {
      snapshot = { fetched_at: new Date(now).toISOString(), deliveries, stale: false };
    },
    observe: () => service.observe(snapshot),
    get now() {
      return now;
    },
    get alarm() {
      return alarm;
    },
    advance: (ms = 60_000) => {
      now += ms;
    },
    authorize: (value) => {
      authorized = value;
    },
    status: (value) => {
      status = value;
    },
    badChallenge: () => {
      challengeValid = false;
    },
    restart: () => {
      service = new EventSubscriptions(deps);
    },
    run: () => service.alarm(),
    call: async (
      method,
      params = PARAMS,
      subscriber = OWNER,
      scopes = ["active_deliveries_read"],
      identity = { userId: subscriber.userId, email: null },
    ) => {
      const response = await handleMcp(
        new Request(OWNER.resource, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        }),
        {},
        {
          identity,
          authorizedScopes: scopes,
          events: (method, params) => service.handle(method, params, subscriber),
          fetcher: () => {
            throw new Error("Diagnostic events must never call Parcel");
          },
        },
      );
      return { status: response.status, ...(await response.json()) };
    },
  };
}

function verifySignature(message, secret = SECRET) {
  const timestamp = message.headers.get("webhook-timestamp");
  const id = message.headers.get("webhook-id");
  const signature = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
    .update(`${id}.${timestamp}.${message.raw}`)
    .digest("base64");
  assert.ok(message.headers.get("webhook-signature").split(" ").includes(`v1,${signature}`));
}

test("authenticated diagnostic subscription survives restart and emits one signed synthetic event", async () => {
  const f = fixture();
  assert.deepEqual((await f.call("initialize")).result.capabilities.events, {});
  assert.equal((await f.call("events/list")).result.events[0].name, PARAMS.name);
  const subscribed = (await f.call("events/subscribe")).result;
  assert.ok(subscribed.id);
  assert.equal(f.alarm, f.now + 60_000);
  verifySignature(f.received[0]);
  assert.equal(f.received[0].headers.get("X-MCP-Subscription-Id"), subscribed.id);
  await f.run();
  assert.equal(f.received.length, 1); // The verification is not the diagnostic event.
  f.restart();
  f.advance();
  await f.run();
  const delivered = f.received[1];
  assert.deepEqual(delivered.body.data, { test_id: "wake-acceptance", synthetic: true });
  assert.equal(delivered.body.name, PARAMS.name);
  assert.equal(delivered.body.eventId, delivered.headers.get("webhook-id"));
  verifySignature(delivered);
  assert.equal((await f.call("events/subscribe")).result.id, subscribed.id);
  f.advance();
  await f.run();
  assert.equal(f.received.length, 2); // Renewal must not rearm a delivered logical event.
  assert.deepEqual((await f.call("events/unsubscribe")).result, {});
  assert.equal(f.alarm, null);
});

test("renewal preserves pending delivery and key rotation signs with old and new keys", async () => {
  const f = fixture();
  const original = (await f.call("events/subscribe")).result;
  f.advance(30_000);
  const replacement = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
  const rotated = await f.call("events/subscribe", {
    ...PARAMS,
    delivery: { ...PARAMS.delivery, secret: replacement },
  });
  assert.equal(rotated.result.id, original.id);
  f.advance(30_000);
  await f.run();
  const event = f.received.at(-1);
  assert.equal(event.body.name, PARAMS.name);
  verifySignature(event);
  verifySignature(event, replacement);
});

test("transient failure retries the same event after restart with a fresh signature; terminal failures stop", async ({
  onTestFinished,
}) => {
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  onTestFinished(() => warnings.mockRestore());
  const f = fixture();
  await f.call("events/subscribe");
  f.status(503);
  f.advance();
  await f.run();
  const first = f.received.at(-1);
  assert.ok(warnings.mock.calls.some(([text]) => JSON.parse(text).status === 503));
  assert.ok(!JSON.stringify(warnings.mock.calls).includes(SECRET));
  assert.ok(!JSON.stringify(warnings.mock.calls).includes(PARAMS.delivery.url));
  assert.equal(f.alarm, f.now + 60_000);
  f.restart();
  f.advance();
  f.status(200);
  await f.run();
  const retry = f.received.at(-1);
  assert.equal(retry.raw, first.raw);
  assert.notEqual(retry.headers.get("webhook-signature"), first.headers.get("webhook-signature"));
  verifySignature(retry);
  const exhausted = fixture();
  await exhausted.call("events/subscribe");
  exhausted.status(503);
  for (let attempt = 0; attempt < 5; attempt++) {
    exhausted.advance(attempt === 0 ? 60_000 : 30_000 * 2 ** attempt);
    await exhausted.run();
  }
  const afterLimit = exhausted.received.length;
  exhausted.advance(1_000_000);
  await exhausted.run();
  assert.equal(exhausted.received.length, afterLimit);
  assert.equal(exhausted.alarm, 1_800_000_000_000 + 3_600_000);
  assert.equal(afterLimit, 6); // One verification plus the bounded five delivery attempts.
  for (const status of [410, 413, 302]) {
    const terminal = fixture();
    await terminal.call("events/subscribe");
    terminal.status(status);
    terminal.advance();
    await terminal.run();
    terminal.advance(600_000);
    await terminal.run();
    assert.equal(terminal.received.length, 2);
  }
});

test("denied scope, invalid callback, failed challenge, and revoked grant cannot activate delivery", async () => {
  const f = fixture();
  assert.equal((await f.call("events/subscribe", PARAMS, OWNER, ["add_delivery"])).status, 403);
  assert.equal((await f.call("events/list", PARAMS, OWNER, [], null)).status, 401);
  assert.equal(f.received.length, 0);
  assert.equal(
    (
      await f.call("events/subscribe", {
        ...PARAMS,
        delivery: { ...PARAMS.delivery, url: "http://localhost/test" },
      })
    ).error.code,
    -32602,
  );
  f.badChallenge();
  assert.equal((await f.call("events/subscribe")).error.code, -32015);
  assert.equal(f.alarm, null);
  const revoked = fixture();
  await revoked.call("events/subscribe");
  revoked.authorize(false);
  revoked.advance();
  await revoked.run();
  assert.equal(revoked.received.length, 1);
  assert.equal(revoked.alarm, null);
});

test("unsubscribe is owner-scoped and cancellation or expiration prevents pending sends", async () => {
  const f = fixture();
  await f.call("events/subscribe");
  await f.call("events/unsubscribe", PARAMS, { ...OWNER, clientId: "other" });
  assert.notEqual(f.alarm, null);
  await f.call("events/unsubscribe");
  await f.call("events/unsubscribe");
  f.advance();
  await f.run();
  assert.equal(f.received.length, 1);
  const expired = fixture();
  await expired.call("events/subscribe", { ...PARAMS, ttlMs: 30_000 });
  expired.advance();
  await expired.run();
  assert.equal(expired.received.length, 1);
  assert.equal(expired.alarm, null);
});

test("callback transport refuses to follow redirects", async () => {
  const fetcher = vi.fn(
    async () => new Response(null, { status: 302, headers: { Location: "https://localhost/" } }),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    assert.equal(
      (await sendCallback(PARAMS.delivery.url, { "webhook-id": "synthetic" }, "{}")).status,
      302,
    );
    assert.equal(fetcher.mock.calls[0][1].redirect, "manual");
  } finally {
    vi.unstubAllGlobals();
  }
});

const FOLLOW = {
  ...PARAMS,
  name: "deliveries.changed",
  arguments: {
    deliveries: [{ carrier_code: "ups", tracking_number: "test" }],
    status_codes: [0, 3, 6, 7],
  },
};
const item = (status_code, change_id) => ({
  carrier_code: "ups",
  tracking_number: "test",
  status_code,
  change_id,
});
const notifications = (f) =>
  f.received.filter((message) => message.body.name === "deliveries.changed");

test("following starts silently; renewal and restart retain baseline, retry identity, and bounded polling", async () => {
  const f = fixture();
  assert.ok((await f.call("events/subscribe", FOLLOW)).result);
  f.snapshot([item(6, "initial")]);
  f.advance();
  await f.run();
  assert.equal(notifications(f).length, 0);
  const reads = f.reads;
  await f.run();
  assert.equal(f.reads, reads);
  f.snapshot([item(2, "moving")]);
  await f.observe();
  f.restart();
  await f.call("events/subscribe", FOLLOW);
  f.snapshot([item(6, "failed-once")]);
  await f.observe();
  f.status(503);
  await f.run();
  const first = notifications(f)[0];
  assert.equal(first.body.data.changes[0].change_id, "failed-once");
  assert.equal(first.body.data.changes[0].previous_status, 2);
  f.restart();
  f.status(200);
  f.advance();
  await f.run();
  assert.equal(notifications(f)[1].raw, first.raw);
  assert.equal(f.reads, reads); // Callback retries consume no extra upstream lookup.
  await f.call("events/unsubscribe", FOLLOW);
  f.advance(20 * 60_000);
  await f.run();
  assert.equal(f.reads, reads);
  assert.equal(f.alarm, null);
});

test("fixed batching excludes superseded or missing deliveries and tracking reuse requires refollow", async () => {
  const f = fixture();
  await f.call("events/subscribe", FOLLOW);
  f.snapshot([item(2, "baseline")]);
  await f.observe();
  f.snapshot([item(3, "pickup")]);
  await f.observe();
  f.advance(20 * 60_000);
  f.snapshot([item(0, "completed")]);
  await f.observe();
  await f.run();
  assert.equal(notifications(f).length, 0);
  f.advance(10 * 60_000 + 1);
  await f.run();
  assert.deepEqual(
    notifications(f)[0].body.data.changes.map((c) => c.change_id),
    ["completed"],
  );
  f.snapshot([item(2, "reused")]);
  await f.observe();
  f.snapshot([item(6, "new-shipment")]);
  await f.observe();
  await f.run();
  assert.equal(notifications(f).length, 1);
  // An independent follow verifies missing is unknown, never a completion.
  const g = fixture();
  await g.call("events/subscribe", FOLLOW);
  g.snapshot([item(2, "baseline")]);
  await g.observe();
  g.snapshot([item(3, "pickup")]);
  await g.observe();
  g.snapshot([]);
  await g.observe();
  g.advance(30 * 60_000);
  await g.run();
  assert.equal(notifications(g).length, 0);
});

test("a superseded failed callback cannot later send obsolete status; revocation and expiry stop monitoring", async () => {
  const f = fixture();
  await f.call("events/subscribe", FOLLOW);
  f.snapshot([item(2, "baseline")]);
  await f.observe();
  f.snapshot([item(6, "failed")]);
  await f.observe();
  f.status(503);
  await f.run();
  const oldId = notifications(f)[0].body.eventId;
  f.snapshot([item(7, "exception")]);
  await f.observe();
  f.status(200);
  await f.run();
  assert.notEqual(notifications(f)[1].body.eventId, oldId);
  assert.deepEqual(
    notifications(f)[1].body.data.changes.map((c) => c.change_id),
    ["exception"],
  );
  f.authorize(false);
  f.advance(20 * 60_000);
  await f.run();
  assert.equal(f.reads, 0);
  assert.equal(f.alarm, null);
  const expired = fixture();
  await expired.call("events/subscribe", { ...FOLLOW, ttlMs: 30_000 });
  expired.advance();
  await expired.run();
  assert.equal(expired.reads, 0);
  assert.equal(expired.alarm, null);
});

test("follow filters are bounded and ordinary scans or unselected categories do not alert", async () => {
  const f = fixture();
  for (const args of [
    { ...FOLLOW.arguments, status_codes: [4] },
    { ...FOLLOW.arguments, deliveries: [] },
    { ...FOLLOW.arguments, deliveries: Array(21).fill(FOLLOW.arguments.deliveries[0]) },
  ]) {
    assert.equal(
      (await f.call("events/subscribe", { ...FOLLOW, arguments: args })).error.code,
      -32602,
    );
  }
  await f.call("events/subscribe", {
    ...FOLLOW,
    arguments: { ...FOLLOW.arguments, status_codes: [6] },
  });
  f.snapshot([item(2, "baseline")]);
  await f.observe();
  f.snapshot([item(4, "out-for-delivery")]);
  await f.observe();
  f.snapshot([item(7, "unselected")]);
  await f.observe();
  await f.run();
  assert.equal(notifications(f).length, 0);
});

test("stale snapshots defer batches until fresh revalidation without spending extra retry reads", async () => {
  const f = fixture();
  await f.call("events/subscribe", FOLLOW);
  f.snapshot([item(2, "initial")]);
  await f.observe();
  f.snapshot([item(3, "pickup")]);
  await f.observe();
  f.stale(true);
  f.advance(30 * 60_000);
  await f.run();
  assert.equal(notifications(f).length, 0);
  const checks = f.reads;
  await f.run();
  assert.equal(f.reads, checks);
  assert.ok(f.alarm > f.now);
  f.stale(false);
  f.advance(11 * 60_000);
  await f.run();
  assert.equal(notifications(f)[0].body.data.changes[0].change_id, "pickup");
});

test("expiry during authorization cannot spend a read and malformed statuses cannot seed a transition", async () => {
  const f = fixture();
  await f.call("events/subscribe", { ...FOLLOW, ttlMs: 100_000 });
  f.advance();
  f.delayAuthorization(60_000);
  await f.run();
  assert.equal(f.reads, 0);
  const g = fixture();
  await g.call("events/subscribe", FOLLOW);
  g.snapshot([item(1.5, "malformed")]);
  await g.observe();
  g.snapshot([item(6, "first-valid")]);
  await g.observe();
  await g.run();
  assert.equal(notifications(g).length, 0);
});
