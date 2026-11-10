// Core MCP handler for the Parcel connection. Framework-agnostic and transport-agnostic:
// handleMcp(request, config, deps) takes a standard Request, configuration, and injectable
// dependencies (approved identity, optional OAuth scopes, fetch, clock, rate reservation).
// src/oauth.ts validates the access token and wires those dependencies; the test suite injects
// mocks and never touches the network.
//
// Authorization model: the caller passes the already-approved identity in `deps.identity`.
// Tool calls without that identity are rejected. When `deps.authorizedScopes` is set, each
// tools/call must include the scope for that tool; a missing or unknown mapping is refused.
// This module does not read proxy headers or tokens. Who may approve a grant is decided at
// /authorize. See README "Security model".

const ENDPOINT = "https://api.parcel.app/external/deliveries/?filter_mode=active";
const ADD_ENDPOINT = "https://api.parcel.app/external/add-delivery/";
const MIN_INTERVAL_MS = 180_001;
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const EMPTY_SCHEMA = { type: "object", properties: {}, additionalProperties: false };
const ADD_FIELDS = {
  tracking_number: 100,
  carrier_code: 40,
  description: 200,
  postcode: 20,
  email: 100,
} as const;
const ADD_SCHEMA = {
  type: "object",
  properties: {
    tracking_number: { type: "string", description: "The carrier tracking number." },
    carrier_code: {
      type: "string",
      description:
        'Parcel carrier code, e.g. "ups", "fedex", "usps". Full list: https://api.parcel.app/external/supported_carriers.json. Use "pholder" for a placeholder.',
    },
    description: {
      type: "string",
      description: "What the package is, shown as the delivery name.",
    },
    postcode: { type: "string", description: "Only for carriers that require a postcode." },
    email: {
      type: "string",
      description: "Only for services that require it, e.g. Apple Store orders.",
    },
  },
  required: ["tracking_number", "carrier_code", "description"],
  additionalProperties: false,
};
const TOOLS = [
  {
    name: "get_connection_status",
    description:
      "Check this Parcel connection and the authenticated identity. Does not read deliveries or reveal credentials.",
    inputSchema: EMPTY_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  {
    name: "list_active_deliveries",
    description:
      "Read the active Parcel deliveries for the configured account. Parcel returns cached information; this does not refresh carriers. No arguments or write actions. At most one upstream request every three minutes; extra tracking information is excluded.",
    inputSchema: EMPTY_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: "add_delivery",
    description:
      "Add one delivery to the Parcel account by tracking number. Check list_active_deliveries first: adding a tracking number that is already tracked wastes budget. Parcel allows 20 add requests per day including failed ones, and rejects tracking numbers in an unknown format. The new delivery shows no tracking data until Parcel first updates it.",
    inputSchema: ADD_SCHEMA,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
];

export type Config = { PARCEL_API_KEY?: string };
export type Identity = { userId: string; email: string | null };
/** Scope required for each tools/call name. Every tool must appear here. */
export const TOOL_SCOPES: Record<(typeof TOOLS)[number]["name"], string> = {
  get_connection_status: "active_deliveries_read",
  list_active_deliveries: "active_deliveries_read",
  add_delivery: "add_delivery",
};
export type Dependencies = {
  /** Approved caller. Omitted or null denies every tool call. */
  identity?: Identity | null;
  /**
   * Scopes on the access token. When set, tools/call is checked against TOOL_SCOPES
   * using this same request parse; a missing scope is 403. Omitted only in unit tests
   * that exercise the tools without an OAuth token.
   */
  authorizedScopes?: readonly string[];
  fetcher?: typeof fetch;
  now?: () => number;
  reserve?: (now: number) => Promise<number | null>;
};

const responseHeaders = {
  "Cache-Control": "private, no-store, max-age=0",
  "X-Content-Type-Options": "nosniff",
};
const json = (data: unknown, status = 200, extra: HeadersInit = {}) =>
  Response.json(data, { status, headers: { ...responseHeaders, ...extra } });
const rpc = (id: unknown, result: unknown) => json({ jsonrpc: "2.0", id, result });
const error = (id: unknown, code: number, message: string, status = 200) =>
  json({ jsonrpc: "2.0", id, error: { code, message } }, status);
const insufficientScope = (scope: string) =>
  json(
    {
      error: "insufficient_scope",
      error_description: "The access token lacks the required scope.",
    },
    403,
    {
      "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
    },
  );
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const toolResult = (data: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  ...(isError ? {} : { structuredContent: data }),
  isError,
});

export function connectionStatus(identity: Identity | null, config: Config) {
  return {
    authenticated_user_id: identity?.userId ?? null,
    authenticated_user_email: identity?.email ?? null,
    authenticated: !!identity,
    secret_configured: !!config.PARCEL_API_KEY,
    scope: "active_deliveries_read, add_delivery",
  };
}

function validateAddArguments(args: unknown): Record<string, string> | string {
  if (!object(args)) return "add_delivery requires tracking_number, carrier_code and description";
  const out: Record<string, string> = {};
  for (const [name, limit] of Object.entries(ADD_FIELDS)) {
    const value = args[name];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > limit)
      return `${name} must be a non-empty string of at most ${limit} characters`;
    out[name] = value.trim();
  }
  for (const name of ADD_SCHEMA.required) if (!(name in out)) return `${name} is required`;
  if (!/^[a-z0-9_-]+$/i.test(out.carrier_code))
    return 'carrier_code must be a Parcel carrier code such as "ups" or "fedex"';
  if (Object.keys(args).some((k) => !(k in ADD_FIELDS))) return "Unknown argument";
  return out;
}

function classifyFailure(caught: unknown, phase: string) {
  const name = caught instanceof Error ? caught.name : "";
  const message = caught instanceof Error ? caught.message : "";
  return name === "TimeoutError" || name === "AbortError"
    ? "UPSTREAM_TIMEOUT"
    : phase === "parse_response"
      ? "UPSTREAM_INVALID_JSON"
      : phase === "read_response"
        ? message === "body_limit"
          ? "UPSTREAM_RESPONSE_TOO_LARGE"
          : "UPSTREAM_BODY_READ_FAILED"
        : phase === "sanitize_response"
          ? "UPSTREAM_SANITIZATION_FAILED"
          : /cache.*(?:unsupported|not implemented)|unsupported cache/i.test(message)
            ? "RUNTIME_CACHE_OPTION_UNSUPPORTED"
            : /header|ByteString|character/i.test(message)
              ? "REQUEST_HEADER_INVALID"
              : /redirect/i.test(message)
                ? "UPSTREAM_REDIRECT_REJECTED"
                : name === "TypeError"
                  ? "UPSTREAM_FETCH_TYPE_ERROR"
                  : "UPSTREAM_FETCH_FAILED";
}

async function addDelivery(fields: Record<string, string>, key: string, fetcher: typeof fetch) {
  const redact = (v: unknown) =>
    typeof v === "string" ? v.replaceAll(key, "[redacted]").slice(0, 300) : undefined;
  let phase = "request";
  let upstreamStatus: number | undefined;
  try {
    const upstream = await fetcher(ADD_ENDPOINT, {
      method: "POST",
      headers: { "api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(fields),
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    upstreamStatus = upstream.status;
    phase = "read_response";
    const text = await boundedText(upstream, 64_000);
    phase = "parse_response";
    let payload: unknown = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (object(payload) && payload.success === true) {
      return toolResult({
        added: true,
        tracking_number: fields.tracking_number,
        carrier_code: fields.carrier_code,
        description: fields.description,
        note: "Parcel will populate tracking data on its next update.",
      });
    }
    const message =
      upstream.status === 429
        ? "Parcel has reached its daily add-delivery limit (20 per day, including failed attempts). Try again tomorrow."
        : [401, 403].includes(upstream.status)
          ? "Parcel rejected the configured API key."
          : (object(payload) && redact(payload.error_message)) ||
            "Parcel did not accept the delivery.";
    return toolResult(
      {
        error: message,
        error_code:
          upstream.status === 429
            ? "UPSTREAM_RATE_LIMITED"
            : object(payload)
              ? "UPSTREAM_REPORTED_ERROR"
              : "UPSTREAM_HTTP_ERROR",
        upstream_status: upstreamStatus,
      },
      true,
    );
  } catch (caught) {
    return toolResult(
      {
        error: "Parcel could not be reached or returned an invalid response.",
        error_code: classifyFailure(caught, phase),
        phase,
        upstream_status: upstreamStatus,
      },
      true,
    );
  }
}

async function boundedText(response: Request | Response, limit: number) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new Error("body_limit");
      }
      parts.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(bytes);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return new TextDecoder().decode(result);
}

function cleanDeliveries(deliveries: unknown[], key: string) {
  const clean = (v: unknown, limit = 1000) =>
    typeof v === "string" ? v.replaceAll(key, "[redacted]").slice(0, limit) : undefined;
  return deliveries
    .slice(0, 200)
    .filter(object)
    .map((d) => {
      const result: Record<string, unknown> = {};
      for (const name of [
        "carrier_code",
        "description",
        "tracking_number",
        "date_expected",
        "date_expected_end",
      ]) {
        if (typeof d[name] === "string") result[name] = clean(d[name]);
      }
      for (const name of ["status_code", "timestamp_expected", "timestamp_expected_end"]) {
        if (typeof d[name] === "number" && Number.isFinite(d[name])) result[name] = d[name];
      }
      result.events = Array.isArray(d.events)
        ? d.events
            .slice(0, 30)
            .filter(object)
            .map((e) => {
              const event: Record<string, unknown> = {};
              for (const name of ["event", "date", "location", "additional"])
                if (typeof e[name] === "string") event[name] = clean(e[name]);
              return event;
            })
        : [];
      return result;
    });
}

export async function handleMcp(request: Request, config: Config, deps: Dependencies = {}) {
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { ...responseHeaders, Allow: "POST" } });
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin)
    return json({ error: "Forbidden origin" }, 403);
  if (!request.headers.get("Content-Type")?.toLowerCase().includes("application/json"))
    return json({ error: "Use application/json" }, 415);
  let body: unknown;
  try {
    body = JSON.parse(await boundedText(request, 8192));
  } catch {
    return error(null, -32700, "Invalid or oversized JSON", 400);
  }
  if (!object(body) || body.jsonrpc !== "2.0" || typeof body.method !== "string")
    return error(null, -32600, "Invalid request", 400);
  const id = body.id ?? null;
  if ("id" in body && typeof id !== "string" && typeof id !== "number" && id !== null)
    return error(null, -32600, "Invalid request ID", 400);
  if (body.method === "notifications/initialized")
    return new Response(null, { status: 202, headers: responseHeaders });
  if (!("id" in body)) return new Response(null, { status: 202, headers: responseHeaders });
  if (body.method === "initialize") {
    const requested = object(body.params) ? body.params.protocolVersion : null;
    return rpc(id, {
      protocolVersion:
        typeof requested === "string" && PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "parcel-connection", version: "1.0.0" },
    });
  }
  if (body.method === "ping") return rpc(id, {});
  if (body.method === "tools/list") return rpc(id, { tools: TOOLS });
  if (body.method !== "tools/call") return error(id, -32601, "Method not found");
  const params = body.params;
  if (!object(params) || !TOOLS.some((t) => t.name === params.name))
    return error(id, -32602, "Unknown tool");
  const addFields =
    params.name === "add_delivery" ? validateAddArguments(params.arguments ?? {}) : null;
  if (typeof addFields === "string") return error(id, -32602, addFields);
  if (
    !addFields &&
    params.arguments !== undefined &&
    (!object(params.arguments) || Object.keys(params.arguments).length)
  )
    return error(id, -32602, "This tool accepts no arguments");

  // The entry point supplies the identity from a validated access token. No identity => no access.
  const identity = deps.identity ?? null;
  if (!identity) return error(id, -32001, "Authentication required", 401);
  // Same parse that named the tool decides the required scope. Unknown mapping or a missing
  // scope refuses the call; the check is not skipped when authorizedScopes is present.
  if (deps.authorizedScopes !== undefined) {
    const needed = TOOL_SCOPES[params.name as keyof typeof TOOL_SCOPES];
    if (typeof needed !== "string" || !deps.authorizedScopes.includes(needed))
      return insufficientScope(typeof needed === "string" ? needed : (params.name as string));
  }

  if (params.name === "get_connection_status")
    return rpc(id, toolResult(connectionStatus(identity, config)));

  if (!config.PARCEL_API_KEY)
    return rpc(id, toolResult({ error: "The Parcel API secret is not configured." }, true));
  if (addFields)
    return rpc(id, await addDelivery(addFields, config.PARCEL_API_KEY, deps.fetcher ?? fetch));
  if (!deps.reserve)
    return rpc(id, toolResult({ error: "The request rate limiter is unavailable." }, true));
  const now = (deps.now ?? Date.now)();
  try {
    const retryAt = await deps.reserve(now);
    if (retryAt !== null)
      return rpc(
        id,
        toolResult(
          {
            error: "Please wait before another Parcel lookup.",
            retry_at: new Date(retryAt).toISOString(),
          },
          true,
        ),
      );
  } catch {
    return rpc(id, toolResult({ error: "The request rate limiter is unavailable." }, true));
  }
  let phase = "request";
  let upstreamStatus: number | undefined;
  let responseType: string | undefined;
  try {
    const upstream = await (deps.fetcher ?? fetch)(ENDPOINT, {
      method: "GET",
      headers: { "api-key": config.PARCEL_API_KEY, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
    upstreamStatus = upstream.status;
    const contentType = upstream.headers.get("Content-Type")?.toLowerCase() ?? "";
    responseType = contentType.includes("json")
      ? "json"
      : contentType.includes("html")
        ? "html"
        : contentType.includes("text")
          ? "text"
          : "other";
    if (!upstream.ok) {
      await upstream.body?.cancel();
      const message =
        upstream.status === 429
          ? "Parcel has reached its request limit. Try again later."
          : [401, 403].includes(upstream.status)
            ? "Parcel rejected the configured API key."
            : "Parcel is temporarily unavailable.";
      return rpc(
        id,
        toolResult(
          {
            error: message,
            error_code:
              upstream.status >= 300 && upstream.status < 400
                ? "UPSTREAM_REDIRECT_REJECTED"
                : "UPSTREAM_HTTP_ERROR",
            upstream_status: upstreamStatus,
          },
          true,
        ),
      );
    }
    phase = "read_response";
    const text = await boundedText(upstream, 2_000_000);
    phase = "parse_response";
    const payload: unknown = JSON.parse(text);
    if (!object(payload) || payload.success !== true || !Array.isArray(payload.deliveries))
      return rpc(
        id,
        toolResult(
          {
            error: "Parcel did not return a valid successful delivery response.",
            error_code:
              object(payload) && payload.success === false
                ? "UPSTREAM_REPORTED_ERROR"
                : "UPSTREAM_INVALID_SCHEMA",
            upstream_status: upstreamStatus,
          },
          true,
        ),
      );
    phase = "sanitize_response";
    return rpc(
      id,
      toolResult({
        source: "Parcel cached API",
        fetched_at: new Date(now).toISOString(),
        filter_mode: "active",
        deliveries: cleanDeliveries(payload.deliveries, config.PARCEL_API_KEY),
        truncated: payload.deliveries.length > 200,
      }),
    );
  } catch (caught) {
    // Classify locally, without returning exception text, response bodies, headers, or credentials.
    return rpc(
      id,
      toolResult(
        {
          error: "Parcel could not be reached or returned an invalid response.",
          error_code: classifyFailure(caught, phase),
          phase,
          upstream_status: upstreamStatus,
          response_type: responseType,
        },
        true,
      ),
    );
  }
}

export { ADD_ENDPOINT, ENDPOINT, MIN_INTERVAL_MS };
