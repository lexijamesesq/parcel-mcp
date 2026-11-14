import { boundedBody } from "./body.ts";

const EVENT_NAME = "notifications.test";
const LIFETIME_MS = 60 * 60_000;
const DELAY_MS = 60_000;
const ROTATION_MS = 5 * 60_000;
const MAX_SUBSCRIPTIONS = 16;
const MAX_ATTEMPTS = 5;
const READ_SCOPE = "active_deliveries_read";
const STATE_KEY = "subscriptions";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

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
  constructor(private readonly deps: EventDependencies) {
    this.now = deps.now ?? Date.now;
  }

  private async load() {
    const records = (await this.deps.storage.get<Subscription[]>(STATE_KEY)) ?? [];
    return records.filter((record) => record.expires > this.now());
  }

  private async save(records: Subscription[]) {
    await this.deps.storage.transaction(async (storage) => {
      await storage.put(STATE_KEY, records);
      const next = records.flatMap((record) => [
        record.expires,
        ...(record.due === null ? [] : [record.due]),
      ]);
      if (next.length) await storage.setAlarm(Math.min(...next));
      else await storage.deleteAlarm();
    });
  }

  async handle(method: string, params: unknown, owner: Subscriber): Promise<EventReply> {
    if (method === "events/list") return { result: { events: [TEST_EVENT] } };
    if (method !== "events/subscribe" && method !== "events/unsubscribe")
      return failure(-32601, "Method not found");
    if (
      !object(params) ||
      params.name !== EVENT_NAME ||
      !object(params.arguments) ||
      Object.keys(params.arguments).length !== 1 ||
      typeof params.arguments.test_id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(params.arguments.test_id) ||
      !object(params.delivery) ||
      params.delivery.mode !== "webhook"
    )
      return failure(-32602, "Invalid event arguments");
    const url = callbackUrl(params.delivery.url);
    if (!url) return failure(-32602, "Invalid HTTPS callback URL");
    const testId = params.arguments.test_id;
    const id = `sub_${await digest(JSON.stringify([owner.userId, owner.clientId, owner.grantId, url, EVENT_NAME, testId]))}`;
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
      return failure(-32602, "This diagnostic event does not support replay");
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
          url,
          secret,
          expires: 0,
          verifiedAt: 0,
          eventId: `evt_${crypto.randomUUID()}`,
          occurredAt: new Date(now).toISOString(),
          due: now + DELAY_MS,
          attempts: 0,
        };
    record.expires =
      now + Math.min(LIFETIME_MS, typeof params.ttlMs === "number" ? params.ttlMs : LIFETIME_MS);
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
          !object(result) ||
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

  async alarm(): Promise<void> {
    let records = await this.load();
    for (const record of [...records]) {
      if (record.due === null || record.due > this.now()) continue;
      try {
        if (!(await this.deps.authorized(record.owner))) {
          records = records.filter((item) => item.id !== record.id);
          await this.save(records);
          continue;
        }
        if (record.expires <= this.now()) continue;
        const body = JSON.stringify({
          eventId: record.eventId,
          name: EVENT_NAME,
          timestamp: record.occurredAt,
          data: { test_id: record.testId, synthetic: true },
          cursor: null,
        });
        const headers = await signedHeaders(record.eventId, record, body, this.now());
        const response = await this.deps.send(record.url, headers, body);
        await response.body?.cancel();
        if (
          response.ok ||
          response.status === 410 ||
          response.status === 413 ||
          (response.status >= 300 && response.status < 400)
        )
          record.due = null;
      } catch {
        /* Retry bounded transient failures; never log callback credentials. */
      }
      record.attempts++;
      if (record.due !== null)
        record.due =
          record.attempts >= MAX_ATTEMPTS ? null : this.now() + 30_000 * 2 ** record.attempts;
      await this.save(records);
    }
    await this.save(records);
  }
}

export { READ_SCOPE };
