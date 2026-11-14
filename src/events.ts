import { boundedBody, isObject } from "./body.ts";
import type { ToolResult } from "./mcp.ts";
import { type Delivery, deliveryKey, READ_INTERVAL_MS, type Snapshot } from "./rate.ts";

const EVENT_NAME = "notifications.test";
const LIFETIME_MS = 60 * 60_000;
const DELAY_MS = 60_000;
const ROTATION_MS = 5 * 60_000;
const MAX_SUBSCRIPTIONS = 16;
const MAX_ATTEMPTS = 5;
const READ_SCOPE = "active_deliveries_read";
const STATE_KEY = "subscriptions";
const POLL_KEY = "monitor-next";
const POLL_MS = 10 * 60_000 + 1;
const BATCH_MS = 30 * 60_000;
const MONITOR_LIFETIME_MS = 24 * 60 * 60_000;
const CHANGE_EVENT = "deliveries.changed";
const STATUS_CODES = [0, 3, 6, 7];
const DELIVERY_SCHEMA = {
  type: "object",
  properties: {
    carrier_code: { type: "string", minLength: 1, maxLength: 40 },
    tracking_number: { type: "string", minLength: 1, maxLength: 100 },
  },
  required: ["carrier_code", "tracking_number"],
  additionalProperties: false,
};
export const DELIVERY_EVENT = {
  name: CHANGE_EVENT,
  description:
    "Follow only explicitly selected deliveries and status categories. Silent initial baseline; no historical replay. Failed attempts (6) and exceptions (7) notify after observation; pickup (3) and completed (0) changes use a 30-minute batching window; delivery may wait longer for fresh revalidation. Missing deliveries are unknown. Checks share the account cache and budget; at most six background reads per hour while subscribed. observed_at is local observation of Parcel's cached API, not carrier time. Compare change_id/current status with list_deliveries before notifying; deduplicate these IDs across retries and daily checks. Unsubscribe to stop following. Renew before refreshBefore; maximum lifetime 24 hours.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: {
      deliveries: {
        type: "array",
        minItems: 1,
        maxItems: 20,
        items: DELIVERY_SCHEMA,
        uniqueItems: true,
      },
      status_codes: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "integer", enum: STATUS_CODES },
        uniqueItems: true,
      },
    },
    required: ["deliveries", "status_codes"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: {
      changes: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          properties: {
            carrier_code: { type: "string" },
            tracking_number: { type: "string" },
            previous_status: { type: "integer" },
            status_code: { type: "integer" },
            change_id: { type: "string" },
            observed_at: { type: "string", format: "date-time" },
          },
          required: [
            "carrier_code",
            "tracking_number",
            "previous_status",
            "status_code",
            "change_id",
            "observed_at",
          ],
          additionalProperties: false,
        },
      },
    },
    required: ["changes"],
    additionalProperties: false,
  },
};
type Follow = {
  deliveries: { carrier_code: string; tracking_number: string }[];
  status_codes: number[];
};
type Change = {
  carrier_code: string;
  tracking_number: string;
  previous_status: number;
  status_code: number;
  change_id: string;
  observed_at: string;
};
function followArguments(value: unknown): Follow | null {
  if (
    !isObject(value) ||
    Object.keys(value).sort().join() !== "deliveries,status_codes" ||
    !Array.isArray(value.deliveries) ||
    !Array.isArray(value.status_codes) ||
    value.deliveries.length < 1 ||
    value.deliveries.length > 20 ||
    value.status_codes.length < 1 ||
    value.status_codes.length > 4
  )
    return null;
  const deliveries: Follow["deliveries"] = [];
  for (const d of value.deliveries) {
    if (
      !isObject(d) ||
      Object.keys(d).sort().join() !== "carrier_code,tracking_number" ||
      typeof d.carrier_code !== "string" ||
      !/^[a-z0-9_-]{1,40}$/i.test(d.carrier_code) ||
      typeof d.tracking_number !== "string" ||
      !d.tracking_number.trim() ||
      d.tracking_number.length > 100 ||
      d.tracking_number !== d.tracking_number.trim()
    )
      return null;
    deliveries.push({ carrier_code: d.carrier_code, tracking_number: d.tracking_number });
  }
  const statuses = value.status_codes;
  if (
    statuses.some((s) => typeof s !== "number" || !STATUS_CODES.includes(s)) ||
    new Set(statuses).size !== statuses.length ||
    new Set(deliveries.map(deliveryKey)).size !== deliveries.length
  )
    return null;
  return {
    deliveries: deliveries.sort((a, b) => deliveryKey(a).localeCompare(deliveryKey(b))),
    status_codes: (statuses as number[]).slice().sort(),
  };
}

export const TEST_EVENT = {
  name: EVENT_NAME,
  description:
    "Test notification delivery without reading or changing deliveries. Explicitly subscribe with a new test_id to receive one synthetic event after at least 60 seconds. Renewing the subscription does not send another event. No replay; subscription expires within one hour.",
  delivery: ["webhook"],
  inputSchema: {
    type: "object",
    properties: { test_id: { type: "string", pattern: "^[a-zA-Z0-9_-]{1,64}$" } },
    required: ["test_id"],
    additionalProperties: false,
  },
  payloadSchema: {
    type: "object",
    properties: { test_id: { type: "string" }, synthetic: { const: true } },
    required: ["test_id", "synthetic"],
    additionalProperties: false,
  },
};

export type Subscriber = { userId: string; clientId: string; grantId: string; resource: string };
export type EventReply =
  | { result: unknown }
  | { error: { code: number; message: string; data?: { reason: string } } };
type Subscription = {
  id: string;
  owner: Subscriber;
  testId: string;
  follow?: Follow;
  observed?: Record<string, number>;
  pending?: Record<string, Change>;
  batchAt?: number | null;
  changes?: Change[];
  checkedAt?: number;
  url: string;
  secret: string;
  previous?: { secret: string; until: number };
  expires: number;
  verifiedAt: number;
  eventId: string;
  occurredAt: string;
  due: number | null;
  attempts: number;
};
export type EventStorage = Pick<DurableObjectStorage, "get" | "transaction">;
type EventDependencies = {
  storage: EventStorage;
  authorized: (owner: Subscriber) => Promise<boolean>;
  send: (url: string, headers: HeadersInit, body: string) => Promise<Response>;
  now?: () => number;
  random?: () => number;
  read?: () => Promise<ToolResult>;
};

const failure = (code: number, message: string, reason?: string): EventReply => ({
  error: { code, message, ...(reason ? { data: { reason } } : {}) },
});

function callbackUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      (url.port && url.port !== "443") ||
      !url.hostname.includes(".") ||
      url.hostname.endsWith(".localhost") ||
      url.hostname.endsWith(".local")
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function keyBytes(secret: unknown): Uint8Array | null {
  if (typeof secret !== "string" || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) return null;
  try {
    const bytes = Uint8Array.from(atob(secret.slice(6)), (char) => char.charCodeAt(0));
    return bytes.length >= 24 && bytes.length <= 64 ? bytes : null;
  } catch {
    return null;
  }
}

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedHeaders(id: string, subscription: Subscription, body: string, now: number) {
  const timestamp = String(Math.floor(now / 1000));
  const secrets = [subscription.secret];
  if (subscription.previous && subscription.previous.until > now)
    secrets.push(subscription.previous.secret);
  const signatures = await Promise.all(
    secrets.map(async (secret) => {
      const bytes = keyBytes(secret);
      if (!bytes) throw new Error("Invalid stored signing key");
      const key = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signed = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${id}.${timestamp}.${body}`),
      );
      return `v1,${btoa(String.fromCharCode(...new Uint8Array(signed)))}`;
    }),
  );
  return {
    "Content-Type": "application/json",
    "webhook-id": id,
    "webhook-timestamp": timestamp,
    "webhook-signature": signatures.join(" "),
    "X-MCP-Subscription-Id": subscription.id,
  };
}

/** The production fetch boundary rejects non-public resolved addresses. Never use
 * a service/VPC binding or resolveOverride here. Local wrangler dev is not proof
 * of this protection. Manual redirects prevent following even one redirect hop. */
export async function sendCallback(
  url: string,
  headers: HeadersInit,
  body: string,
): Promise<Response> {
  if (!callbackUrl(url)) throw new Error("Invalid callback");
  return fetch(url, {
    method: "POST",
    headers,
    body,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
}

/** State is persisted in the account's Durable Object. The adapter serializes
 * operations, including delivery, so unsubscribe cannot be followed by a send. */
export class EventSubscriptions {
  private readonly now: () => number;
  private pollAt: number | undefined;
  constructor(private readonly deps: EventDependencies) {
    this.now = deps.now ?? Date.now;
  }

  private async load() {
    this.pollAt = await this.deps.storage.get<number>(POLL_KEY);
    const records = (await this.deps.storage.get<Subscription[]>(STATE_KEY)) ?? [];
    return records.filter((record) => record.expires > this.now());
  }

  private async save(records: Subscription[]) {
    await this.deps.storage.transaction(async (storage) => {
      await storage.put(STATE_KEY, records);
      if (records.some((r) => r.follow) && this.pollAt === undefined)
        this.pollAt = this.now() + 60_000;
      if (this.pollAt !== undefined) await storage.put(POLL_KEY, this.pollAt);
      const next = records.flatMap((record) => [
        record.expires,
        ...(record.due === null ? [] : [record.due]),
        ...(record.batchAt == null ? [] : [record.batchAt]),
      ]);
      if (records.some((r) => r.follow) && this.pollAt !== undefined) next.push(this.pollAt);
      if (next.length) await storage.setAlarm(Math.min(...next));
      else await storage.deleteAlarm();
    });
  }

  async handle(method: string, params: unknown, owner: Subscriber): Promise<EventReply> {
    if (method === "events/list") return { result: { events: [TEST_EVENT, DELIVERY_EVENT] } };
    if (method !== "events/subscribe" && method !== "events/unsubscribe")
      return failure(-32601, "Method not found");
    if (!isObject(params) || !isObject(params.delivery) || params.delivery.mode !== "webhook")
      return failure(-32602, "Invalid event arguments");
    const follow = params.name === CHANGE_EVENT ? followArguments(params.arguments) : null;
    const diagnostic =
      params.name === EVENT_NAME &&
      isObject(params.arguments) &&
      Object.keys(params.arguments).length === 1 &&
      typeof params.arguments.test_id === "string" &&
      /^[a-zA-Z0-9_-]{1,64}$/.test(params.arguments.test_id);
    if (!follow && !diagnostic) return failure(-32602, "Invalid event arguments");
    const url = callbackUrl(params.delivery.url);
    if (!url) return failure(-32602, "Invalid HTTPS callback URL");
    const testId = diagnostic ? (params.arguments as { test_id: string }).test_id : "";
    const id = `sub_${await digest(JSON.stringify([owner.userId, owner.clientId, owner.grantId, url, params.name, follow ?? testId]))}`;
    const records = await this.load();
    const existing = records.find((record) => record.id === id);
    if (method === "events/unsubscribe") {
      await this.save(records.filter((record) => record.id !== id));
      return { result: {} };
    }
    const secret = params.delivery.secret;
    const secretBytes = keyBytes(secret);
    if (typeof secret !== "string" || !secretBytes)
      return failure(-32602, "Invalid webhook signing secret");
    if (params.cursor !== undefined && params.cursor !== null)
      return failure(-32602, "This event does not support replay");
    if (
      params.ttlMs !== undefined &&
      params.ttlMs !== null &&
      (typeof params.ttlMs !== "number" || !Number.isFinite(params.ttlMs) || params.ttlMs <= 0)
    )
      return failure(-32602, "Invalid subscription lifetime");
    if (!existing && records.length >= MAX_SUBSCRIPTIONS)
      return failure(-32000, "Subscription limit reached");
    const now = this.now();
    const record: Subscription = existing
      ? { ...existing }
      : {
          id,
          owner,
          testId,
          ...(follow ? { follow, observed: {}, pending: {}, batchAt: null } : {}),
          url,
          secret,
          expires: 0,
          verifiedAt: 0,
          eventId: `evt_${crypto.randomUUID()}`,
          occurredAt: new Date(now).toISOString(),
          due: follow ? null : now + DELAY_MS,
          attempts: 0,
        };
    record.expires =
      now +
      Math.min(
        follow ? MONITOR_LIFETIME_MS : LIFETIME_MS,
        typeof params.ttlMs === "number"
          ? params.ttlMs
          : follow
            ? MONITOR_LIFETIME_MS
            : LIFETIME_MS,
      );
    if (record.secret !== secret) {
      record.previous = { secret: record.secret, until: now + ROTATION_MS };
      record.secret = secret;
    }
    if (!(await this.deps.authorized(owner)))
      return failure(-32001, "Subscription authorization unavailable");
    if (!existing || now - record.verifiedAt >= ROTATION_MS || existing.secret !== secret) {
      const challenge = crypto.randomUUID();
      const body = JSON.stringify({ type: "verification", challenge });
      try {
        const headers = await signedHeaders(`verify_${crypto.randomUUID()}`, record, body, now);
        const response = await this.deps.send(url, headers, body);
        if (!response.ok) {
          await response.body?.cancel();
          return failure(-32015, "Callback verification failed", "challenge_failed");
        }
        const result: unknown = JSON.parse(
          new TextDecoder().decode(await boundedBody(response, 4096)),
        );
        const challengeKey = await crypto.subtle.importKey(
          "raw",
          secretBytes,
          { name: "HMAC", hash: "SHA-256" },
          false,
          ["sign", "verify"],
        );
        const signature = await crypto.subtle.sign(
          "HMAC",
          challengeKey,
          new TextEncoder().encode(challenge),
        );
        if (
          !isObject(result) ||
          typeof result.challenge !== "string" ||
          !(await crypto.subtle.verify(
            "HMAC",
            challengeKey,
            signature,
            new TextEncoder().encode(result.challenge),
          ))
        )
          return failure(-32015, "Callback verification failed", "challenge_failed");
        record.verifiedAt = now;
      } catch {
        return failure(-32015, "Callback verification failed", "unavailable");
      }
    }
    await this.save([...records.filter((item) => item.id !== id), record]);
    return {
      result: {
        id,
        refreshBefore: new Date(record.expires).toISOString(),
        cursor: null,
        truncated: false,
      },
    };
  }

  /** Called for both interactive and background reads inside the account queue. */
  async observe(snapshot: Snapshot): Promise<void> {
    const records = await this.load();
    this.observeRecords(records, snapshot);
    await this.save(records);
  }

  private observeRecords(records: Subscription[], snapshot: Snapshot) {
    const current = new Map(
      snapshot.deliveries
        .filter(
          (d): d is Delivery =>
            typeof d.carrier_code === "string" &&
            typeof d.tracking_number === "string" &&
            typeof d.status_code === "number" &&
            Number.isInteger(d.status_code) &&
            d.status_code >= 0 &&
            d.status_code <= 8 &&
            typeof d.change_id === "string",
        )
        .map((d) => [deliveryKey(d), d]),
    );
    for (const record of records) {
      if (!record.follow) continue;
      record.checkedAt = Date.parse(snapshot.fetched_at);
      record.observed ??= {};
      record.pending ??= {};
      const observed = record.observed;
      const pending = record.pending;
      for (const followed of record.follow.deliveries) {
        const key = deliveryKey(followed);
        const item = current.get(key);
        if (!item) {
          delete pending[key];
          continue;
        }
        const previous = observed[key];
        // A completed identity reused for a new shipment needs an explicit new follow.
        if (previous === -1 || (previous === 0 && item.status_code !== 0)) {
          observed[key] = -1;
          delete pending[key];
          continue;
        }
        observed[key] = item.status_code;
        if (previous === undefined || previous === item.status_code) continue;
        delete pending[key];
        if (record.follow.status_codes.includes(item.status_code)) {
          pending[key] = {
            ...followed,
            previous_status: previous,
            status_code: item.status_code,
            change_id: item.change_id,
            observed_at: snapshot.fetched_at,
          };
          const due =
            this.now() + (item.status_code === 6 || item.status_code === 7 ? 0 : BATCH_MS);
          record.batchAt = Math.min(record.batchAt ?? due, due);
        }
      }
      // Never mutate a body under its retry ID. Replace the envelope if any member
      // disappeared or was superseded; retain only still-current unsent changes.
      if (
        record.changes?.some(
          (c) =>
            current.get(deliveryKey(c))?.change_id !== c.change_id ||
            observed[deliveryKey(c)] === -1,
        )
      ) {
        for (const c of record.changes)
          if (
            current.get(deliveryKey(c))?.change_id === c.change_id &&
            observed[deliveryKey(c)] !== -1 &&
            !pending[deliveryKey(c)]
          )
            pending[deliveryKey(c)] = c;
        record.changes = undefined;
        record.due = null;
        if (Object.keys(pending).length) record.batchAt ??= this.now();
      }
      if (!Object.keys(pending).length) record.batchAt = null;
    }
  }

  async alarm(): Promise<void> {
    let records = await this.load();
    const active: Subscription[] = [];
    for (const record of records) {
      // Authorization failures stop monitoring until the next bounded attempt.
      try {
        if (await this.deps.authorized(record.owner)) active.push(record);
      } catch {
        active.push(record);
      }
    }
    records = active;
    if (records.some((r) => r.follow) && (this.pollAt ?? 0) <= this.now()) {
      this.pollAt = this.now() + POLL_MS + Math.floor((this.deps.random ?? Math.random)() * 60_000);
      await this.save(records);
      // Recheck authorization before spending the shared upstream budget.
      const allowed: Subscription[] = [];
      for (const record of records.filter((r) => r.follow)) {
        try {
          if (await this.deps.authorized(record.owner)) allowed.push(record);
        } catch {
          /* unavailable is not authorization */
        }
      }
      if (allowed.some((record) => record.expires > this.now()) && this.deps.read) {
        const result = await this.deps.read();
        if (
          !result.isError &&
          isObject(result.structuredContent) &&
          result.structuredContent.stale === false
        )
          this.observeRecords(records, result.structuredContent as Snapshot);
      }
    }
    for (const record of records) {
      if (record.follow && record.batchAt != null && record.batchAt <= this.now()) {
        record.changes = Object.values({
          ...Object.fromEntries((record.changes ?? []).map((c) => [deliveryKey(c), c])),
          ...record.pending,
        });
        record.pending = {};
        record.batchAt = null;
        record.eventId = `evt_${crypto.randomUUID()}`;
        record.occurredAt = new Date(this.now()).toISOString();
        record.attempts = 0;
        record.due = record.changes.length ? this.now() : null;
      }
    }
    // Durable outbox is committed before any callback, including on alarm retry.
    await this.save(records);
    for (const record of [...records]) {
      if (record.due === null || record.due > this.now()) continue;
      if (
        record.follow &&
        (record.checkedAt === undefined ||
          !Number.isFinite(record.checkedAt) ||
          this.now() - record.checkedAt >= READ_INTERVAL_MS)
      ) {
        record.due = Math.max(this.now() + 60_000, this.pollAt ?? this.now() + POLL_MS);
        continue;
      }
      let phase = "authorize";
      try {
        if (!(await this.deps.authorized(record.owner))) {
          records = records.filter((item) => item.id !== record.id);
          await this.save(records);
          continue;
        }
        if (record.expires <= this.now()) continue;
        const body = JSON.stringify({
          eventId: record.eventId,
          name: record.follow ? CHANGE_EVENT : EVENT_NAME,
          timestamp: record.occurredAt,
          data: record.follow
            ? { changes: record.changes }
            : { test_id: record.testId, synthetic: true },
          cursor: null,
        });
        phase = "sign";
        const headers = await signedHeaders(record.eventId, record, body, this.now());
        phase = "send";
        const response = await this.deps.send(record.url, headers, body);
        await response.body?.cancel();
        if (!response.ok)
          console.warn(
            JSON.stringify({
              source: "parcel-mcp-events",
              event_id: record.eventId,
              code: "callback_rejected",
              status: response.status,
            }),
          );
        if (response.status === 410 || (response.status >= 300 && response.status < 400))
          records = records.filter((item) => item.id !== record.id);
        if (
          response.ok ||
          response.status === 410 ||
          response.status === 413 ||
          (response.status >= 300 && response.status < 400)
        )
          record.due = null;
      } catch {
        console.warn(
          JSON.stringify({
            source: "parcel-mcp-events",
            event_id: record.eventId,
            code: "delivery_failed",
            phase,
          }),
        );
      }
      record.attempts++;
      if (record.due !== null)
        record.due =
          record.attempts >= MAX_ATTEMPTS ? null : this.now() + 30_000 * 2 ** record.attempts;
      if (record.due === null) record.changes = undefined;
      await this.save(records);
    }
    await this.save(records);
  }
}

export { READ_SCOPE };
