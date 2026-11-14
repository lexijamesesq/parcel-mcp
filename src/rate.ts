import { isObject } from "./body.ts";
import type { EventStorage } from "./events.ts";
import { fetchDeliveries, type ToolResult, toolResult } from "./mcp.ts";

const STATE_KEY = "parcel-read";
export const READ_INTERVAL_MS = 5 * 60_000 + 1;
const MAX_BACKOFF_MS = 60 * 60_000;
const MAX_KNOWN = 1_000;
const CACHE_BYTES = 750_000;
const KNOWN_BYTES = 500_000;
const RETENTION_MS = 30 * 24 * 60 * 60_000;
export type Delivery = Record<string, unknown> & {
  carrier_code: string;
  tracking_number: string;
  status_code: number;
  change_id: string;
};
export type Snapshot = {
  fetched_at: string;
  deliveries: Record<string, unknown>[];
  [key: string]: unknown;
};
type Known = { status: number; id: string; seen: number };
type ReadState = {
  next: number;
  failures: number;
  snapshot?: Snapshot;
  known: Record<string, Known>;
};
export const deliveryKey = (d: { carrier_code: string; tracking_number: string }) =>
  JSON.stringify([d.carrier_code, d.tracking_number]);

/** Called only inside ParcelAccount's serial queue. Persist reservations before I/O,
 * including failed attempts. One configured Parcel account shares this cache and budget. */
export class ParcelReads {
  constructor(
    private readonly deps: {
      storage: EventStorage;
      key: string;
      fetcher?: typeof fetch;
      now?: () => number;
      random?: () => number;
    },
  ) {}

  async read(): Promise<ToolResult> {
    if (!this.deps.key)
      return toolResult({ error: "The Parcel API secret is not configured." }, true);
    const now = (this.deps.now ?? Date.now)();
    const state = (await this.deps.storage.get<ReadState>(STATE_KEY)) ?? {
      next: 0,
      failures: 0,
      known: {},
    };
    const save = () =>
      this.deps.storage.transaction(async (s) => {
        await s.put(STATE_KEY, state);
      });
    const cached = (snapshot: Snapshot) =>
      toolResult({
        ...snapshot,
        observation_age_ms: now - Date.parse(snapshot.fetched_at),
        stale: now - Date.parse(snapshot.fetched_at) >= READ_INTERVAL_MS,
        retry_at: new Date(state.next).toISOString(),
      });
    if (state.next > now) {
      return state.snapshot
        ? cached(state.snapshot)
        : toolResult(
            {
              error: "Please wait before another Parcel lookup.",
              retry_at: new Date(state.next).toISOString(),
            },
            true,
          );
    }
    state.next = now + READ_INTERVAL_MS;
    await save();
    const result = await fetchDeliveries(this.deps.key, this.deps.fetcher ?? fetch, now);
    const data = result.structuredContent;
    if (result.isError || !isObject(data) || !Array.isArray(data.deliveries)) {
      state.failures++;
      const error = JSON.parse(result.content[0].text);
      const delay =
        error.upstream_status === 429
          ? MAX_BACKOFF_MS
          : Math.min(MAX_BACKOFF_MS, READ_INTERVAL_MS * 2 ** Math.min(state.failures, 4));
      state.next = Math.max(
        now + delay + Math.floor((this.deps.random ?? Math.random)() * 60_000),
        typeof error.retry_at_ms === "number" ? error.retry_at_ms : 0,
      );
      await save();
      return state.snapshot
        ? cached(state.snapshot)
        : toolResult({ ...error, retry_at: new Date(state.next).toISOString() }, true);
    }
    const deliveries = data.deliveries.filter(isObject).map((d) => {
      if (
        typeof d.carrier_code !== "string" ||
        typeof d.tracking_number !== "string" ||
        typeof d.status_code !== "number" ||
        !Number.isInteger(d.status_code) ||
        d.status_code < 0 ||
        d.status_code > 8
      )
        return d;
      const identity = { carrier_code: d.carrier_code, tracking_number: d.tracking_number };
      const key = deliveryKey(identity);
      const previous = state.known[key];
      const id =
        previous?.status === d.status_code && previous.seen > now - RETENTION_MS
          ? previous.id
          : `change_${crypto.randomUUID()}`;
      state.known[key] = { status: d.status_code, id, seen: now };
      return { ...d, change_id: id };
    });
    let knownBytes = 0;
    let cacheBytes = 0;
    const encoder = new TextEncoder();
    state.known = Object.fromEntries(
      Object.entries(state.known)
        .filter(([, v]) => v.seen > now - RETENTION_MS)
        .sort((a, b) => b[1].seen - a[1].seen)
        .slice(0, MAX_KNOWN)
        .filter((entry) => {
          knownBytes += encoder.encode(JSON.stringify(entry)).byteLength;
          return knownBytes <= KNOWN_BYTES;
        }),
    );
    const bounded = deliveries.filter((d) => {
      cacheBytes += encoder.encode(JSON.stringify(d)).byteLength;
      return cacheBytes <= CACHE_BYTES;
    });
    state.snapshot = {
      ...data,
      fetched_at: new Date(now).toISOString(),
      deliveries: bounded,
      truncated: data.truncated || bounded.length < deliveries.length,
    };
    state.failures = 0;
    await save();
    return cached(state.snapshot);
  }
}
