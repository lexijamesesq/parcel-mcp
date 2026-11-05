import { MIN_INTERVAL_MS } from "./mcp.ts";

// Cross-instance request throttle backed by one KV key that expires when the window closes. Every
// upstream attempt, including failed ones, must be separated by at least MIN_INTERVAL_MS.
//
// Returns null when the caller may proceed, or the epoch-ms time to retry when it may not. KV is
// eventually consistent, so two calls in the same instant can both pass; the worst case is one extra
// upstream request, which Parcel answers with a 429 the caller already handles. All deployments that
// share one Parcel API key must share one namespace, or the shared allowance is not enforced.
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
