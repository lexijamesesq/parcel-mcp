import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { ParcelAccount } from "../src/account.ts";
import type { EventStorage } from "../src/events.ts";
import { ParcelReads, READ_INTERVAL_MS } from "../src/rate.ts";

function fixture() {
  const data = new Map();
  const storage = {
    get: async (key) => structuredClone(data.get(key)),
    transaction: async (work) =>
      work({
        put: async (key, value) => data.set(key, structuredClone(value)),
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      }),
  } as EventStorage;
  return storage;
}
const delivery = { carrier_code: "ups", tracking_number: "test", status_code: 2 };
const contents = (result) => result.structuredContent ?? JSON.parse(result.content[0].text);

test("concurrent account reads coalesce; restart retains cache and stable change identities", async () => {
  const storage = fixture();
  let now = 1_800_000_000_000;
  let requests = 0;
  let status = 2;
  const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", async () => {
    requests++;
    return Response.json({ success: true, deliveries: [{ ...delivery, status_code: status }] });
  });
  const account = () =>
    new ParcelAccount({ storage } as DurableObjectState, { PARCEL_API_KEY: "test-key" });
  try {
    let service = account();
    const [first, second] = await Promise.all([service.read(), service.read()]);
    assert.equal(requests, 1); // Shared budget is the requirement, including concurrent clients.
    assert.deepEqual(contents(first), contents(second));
    const id = contents(first).deliveries[0].change_id;
    now += 60_000;
    service = account();
    assert.equal(contents(await service.read()).observation_age_ms, 60_000);
    assert.equal(requests, 1);
    now += READ_INTERVAL_MS;
    assert.equal(contents(await service.read()).deliveries[0].change_id, id);
    status = 6;
    now += READ_INTERVAL_MS;
    assert.notEqual(contents(await service.read()).deliveries[0].change_id, id);
  } finally {
    clock.mockRestore();
    vi.unstubAllGlobals();
  }
});

test("failed attempts reserve budget durably and 429 delays all reads without a catch-up burst", async () => {
  const storage = fixture();
  let now = 1_800_000_000_000;
  let calls = 0;
  let limited = false;
  const deps = {
    storage,
    key: "test-key",
    now: () => now,
    random: () => 0,
    fetcher: async () => {
      calls++;
      return limited
        ? new Response(null, { status: 429, headers: { "Retry-After": "7200" } })
        : Response.json({ success: true, deliveries: [delivery] });
    },
  };
  let service = new ParcelReads(deps);
  await service.read();
  now += READ_INTERVAL_MS;
  limited = true;
  const stale = contents(await service.read());
  assert.equal(stale.stale, true);
  assert.equal(stale.retry_at, new Date(now + 7_200_000).toISOString());
  service = new ParcelReads(deps);
  now += 3_600_000;
  assert.equal(contents(await service.read()).stale, true);
  assert.equal(calls, 2);
  now += 3_600_000;
  limited = false;
  assert.equal(contents(await service.read()).stale, false);
  await service.read();
  assert.equal(calls, 3);
});

test("an interrupted attempt or failed reservation cannot bypass the persisted read gate", async () => {
  const storage = fixture();
  const now = 1_800_000_000_000;
  let calls = 0;
  const deps = {
    storage,
    key: "test-key",
    now: () => now,
    random: () => 0,
    fetcher: async () => {
      calls++;
      throw new Error("upstream down");
    },
  };
  await new ParcelReads(deps).read();
  const refused = await new ParcelReads(deps).read();
  assert.equal(refused.isError, true);
  assert.equal(calls, 1);
  const broken = {
    ...storage,
    transaction: async () => {
      throw new Error("storage unavailable");
    },
  };
  await assert.rejects(
    new ParcelReads({ ...deps, storage: broken, now: () => now + 3_600_000 }).read(),
  );
  assert.equal(calls, 1);
});

test("cache storage is byte bounded and expired identity records are not revived", async () => {
  const storage = fixture();
  let now = 1_800_000_000_000;
  let huge = false;
  const deps = {
    storage,
    key: "test-key",
    now: () => now,
    fetcher: async () =>
      Response.json({
        success: true,
        deliveries: huge
          ? Array.from({ length: 200 }, (_, i) => ({
              ...delivery,
              tracking_number: String(i),
              events: Array.from({ length: 10 }, () => ({ event: "x".repeat(700) })),
            }))
          : [delivery],
      }),
  };
  const service = new ParcelReads(deps);
  const original = contents(await service.read()).deliveries[0].change_id;
  now += 31 * 24 * 60 * 60_000;
  assert.notEqual(contents(await service.read()).deliveries[0].change_id, original);
  huge = true;
  now += READ_INTERVAL_MS;
  const bounded = contents(await service.read());
  assert.equal(bounded.truncated, true);
  assert.ok(bounded.deliveries.length > 0);
  assert.ok(
    new TextEncoder().encode(JSON.stringify(await storage.get("parcel-read"))).byteLength <
      2_000_000,
  );
});
