// In-memory KV sufficient for the OAuth provider and the rate limiter. Values stay strings;
// `type: "json"` parses a copy so callers can mutate the result without changing the stored
// record. Expiration is honored on read and list.

type Row = { value: string; expiration?: number; metadata?: unknown };

export function memoryKv() {
  const store = new Map<string, Row>();
  const alive = (row: Row, nowSec: number) =>
    row.expiration === undefined || row.expiration > nowSec;
  return {
    async get(key: string, options?: { type?: string }) {
      const nowSec = Math.floor(Date.now() / 1000);
      const row = store.get(key);
      if (!row || !alive(row, nowSec)) {
        if (row) store.delete(key);
        return null;
      }
      if (options?.type === "json") return JSON.parse(row.value) as unknown;
      return row.value;
    },
    async put(
      key: string,
      value: string,
      options?: { expiration?: number; expirationTtl?: number; metadata?: unknown },
    ) {
      const expiration =
        options?.expiration ??
        (options?.expirationTtl !== undefined
          ? Math.floor(Date.now() / 1000) + options.expirationTtl
          : undefined);
      store.set(key, { value, expiration, metadata: options?.metadata });
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list(options?: { prefix?: string; limit?: number; cursor?: string }) {
      const nowSec = Math.floor(Date.now() / 1000);
      const prefix = options?.prefix ?? "";
      const keys = [...store.entries()]
        .filter(([name, row]) => name.startsWith(prefix) && alive(row, nowSec))
        .map(([name, row]) => ({ name, metadata: row.metadata }));
      const start = options?.cursor ? Number(options.cursor) || 0 : 0;
      const limit = options?.limit ?? keys.length;
      const slice = keys.slice(start, start + limit);
      const next = start + slice.length;
      return {
        keys: slice,
        list_complete: next >= keys.length,
        cursor: next >= keys.length ? "" : String(next),
      };
    },
  };
}
