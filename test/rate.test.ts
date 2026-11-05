import assert from "node:assert/strict";
import { test } from "vitest";
import { MIN_INTERVAL_MS } from "../src/mcp.ts";
import { reserveParcelRead } from "../src/rate.ts";

function fakeKv() {
  const store = new Map<string, { value: string; expiration: number }>();
  return {
    puts: [] as number[],
    async get(key: string) {
      return store.get(key)?.value ?? null;
    },
    async put(key: string, value: string, opts: { expiration: number }) {
      this.puts.push(opts.expiration);
      store.set(key, { value, expiration: opts.expiration });
    },
    expire(nowMs: number) {
      for (const [k, v] of store) if (v.expiration * 1000 <= nowMs) store.delete(k);
    },
  };
}

test("the first caller wins the window; a second inside it is refused with the retry time", async () => {
  const kv = fakeKv();
  const t0 = 1_700_000_000_000;
  assert.equal(await reserveParcelRead(kv as unknown as KVNamespace, t0), null);
  assert.equal(
    await reserveParcelRead(kv as unknown as KVNamespace, t0 + 1000),
    t0 + MIN_INTERVAL_MS,
  );
  assert.equal(kv.puts[0], Math.ceil((t0 + MIN_INTERVAL_MS) / 1000));
});

test("the window reopens once the key has expired", async () => {
  const kv = fakeKv();
  const t0 = 1_700_000_000_000;
  await reserveParcelRead(kv as unknown as KVNamespace, t0);
  const later = t0 + MIN_INTERVAL_MS + 1000;
  kv.expire(later);
  assert.equal(await reserveParcelRead(kv as unknown as KVNamespace, later), null);
});

test("a missing namespace fails closed", async () => {
  await assert.rejects(reserveParcelRead(undefined, Date.now()), /rate_limiter_unavailable/);
});
