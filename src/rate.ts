import { MIN_INTERVAL_MS } from "./mcp.ts";

// Best-effort cross-instance throttle. KV reads and writes are not atomic: concurrent calls
// or stale replicas can admit multiple upstream attempts within MIN_INTERVAL_MS. Parcel's
// own 429 remains authoritative. Share this namespace across deployments using the same
// Parcel API key. Returns null to proceed, or an epoch-ms retry time; unavailable KV fails closed.
export async function reserveParcelRead(
  kv: KVNamespace | undefined,
  now: number,
): Promise<number | null> {
  if (!kv) throw new Error("rate_limiter_unavailable");
  const held = await kv.get("active");
  if (held !== null) {
    const retryAt = Number(held);
    if (Number.isFinite(retryAt) && retryAt > now) return retryAt;
  }
  const nextAllowedAt = now + MIN_INTERVAL_MS;
  await kv.put("active", String(nextAllowedAt), { expiration: Math.ceil(nextAllowedAt / 1000) });
  return null;
}
