type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

interface GrokConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutSeconds: number;
  extraBody: Record<string, JsonValue>;
  extraHeaders: Record<string, string>;
}

interface Env {
  GROK_BASE_URL: string;
  GROK_API_KEY: string;
  GROK_MODEL?: string;
  GROK_TIMEOUT_SECONDS?: string;
  GROK_PUBLIC_TOKEN: string;
  GROK_EXTRA_BODY_JSON?: string;
  GROK_EXTRA_HEADERS_JSON?: string;
  ALLOWED_ORIGINS?: string;
}

const MCP_PATHS = new Set(["/mcp", "/mcp/"]);
const DEFAULT_MODEL = "grok-4";
const DEFAULT_TIMEOUT_SECONDS = 300;
const MIN_TIMEOUT_SECONDS = 1;
const MAX_TIMEOUT_SECONDS = 600;
const BLOCKED_EXTRA_HEADER_NAMES = new Set([
  "authorization",
  "content-type",
  "content-length",
  "host",
]);
const BATCH_CONCURRENCY = 3;
const SERVER_NAME = "grok_search_worker";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

function jsonResponse(body: JsonValue, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), {
    status,
    headers,
  });
}

function textResponse(text: string, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(text, {
    status,
    headers,
  });
}

function parseAllowedOrigins(value?: string): Set<string> {
  if (!value) return new Set();
  return new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  );
}

function isOriginAllowed(origin: string, allowed: Set<string>): boolean {
  if (allowed.size === 0) return true;
  return allowed.has(origin);
}

function corsHeaders(origin: string | null, allowed: Set<string>): Headers {
  const headers = new Headers({
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  });
  if (origin && isOriginAllowed(origin, allowed)) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  return headers;
}

function extractBearerToken(header: string | null): string {
  if (!header) return "";
  const trimmed = header.trim();
  if (trimmed.toLowerCase().startsWith("bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

function parseJsonObject(value?: string): Record<string, JsonValue> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, JsonValue>;
    }
  } catch {}
  return {};
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) {
    return trimmed.slice(0, -3);
  }
  return trimmed;
}

function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s)\]}>\"']+/g) ?? [];
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?'"]+$/, "");
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    urls.push(cleaned);
  }
  return urls;
}

function coerceJsonObject(text: string): Record<string, JsonValue> | null {
  let trimmed = text.trim();
  if (!trimmed) return null;
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced) {
    trimmed = fenced[1].trim();
  }
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, JsonValue>;
    }
  } catch {}
  return null;
}

function clampTimeoutSeconds(value?: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_TIMEOUT_SECONDS;
  }
  return Math.min(MAX_TIMEOUT_SECONDS, Math.max(MIN_TIMEOUT_SECONDS, Math.floor(value)));
}

function truncateText(text: string, maxLength = 2000): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

function upstreamConfigured(): Record<string, JsonValue> {
  return { upstream: "configured" };
}

function isBlockedExtraHeader(name: string): boolean {
  return BLOCKED_EXTRA_HEADER_NAMES.has(name.trim().toLowerCase());
}

function parseSseCompletionPayload(rawText: string): Record<string, JsonValue> | null {
  if (!rawText.trimStart().startsWith("data:")) return null;

  let content = "";
  let model: JsonValue = "";
  let usage: JsonValue = {};
  let parsedAnyChunk = false;

  for (const event of rawText.split(/\r?\n\r?\n/)) {
    const data = event
      .split(/\r?\n/)
      .map((line) => line.trimStart())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();

    if (!data || data === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(data);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }
      const chunk = parsed as Record<string, JsonValue>;
      parsedAnyChunk = true;
      model = chunk.model ?? model;
      usage = chunk.usage ?? usage;

      const choices = chunk.choices;
      if (!Array.isArray(choices)) {
        continue;
      }
      const choice = choices[0];
      if (!choice || typeof choice !== "object" || Array.isArray(choice)) {
        continue;
      }
      const choiceObject = choice as Record<string, JsonValue>;
      const delta = choiceObject.delta;
      const message = choiceObject.message;
      if (delta && typeof delta === "object" && !Array.isArray(delta)) {
        const deltaContent = (delta as Record<string, JsonValue>).content;
        if (typeof deltaContent === "string") {
          content += deltaContent;
        }
      }
      if (message && typeof message === "object" && !Array.isArray(message)) {
        const messageContent = (message as Record<string, JsonValue>).content;
        if (typeof messageContent === "string") {
          content += messageContent;
        }
      }
    } catch {}
  }

  if (!parsedAnyChunk) return null;
  return {
    object: "chat.completion",
    model,
    choices: [{ message: { content } }],
    usage,
    response_format: "sse",
  };
}

function parseCompletionPayload(rawText: string): {
  payload?: Record<string, JsonValue>;
  detail?: string;
  raw?: string;
} {
  const ssePayload = parseSseCompletionPayload(rawText);
  if (ssePayload) {
    return { payload: ssePayload };
  }

  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        detail: "Upstream response JSON is not an object.",
        raw: truncateText(rawText),
      };
    }
    return { payload: parsed as Record<string, JsonValue> };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { detail, raw: truncateText(rawText) };
  }
}

function buildGrokConfig(
  env: Env,
  overrides: {
    model?: string;
    timeoutSeconds?: number;
    extraBodyJson?: string;
    extraHeadersJson?: string;
  },
): GrokConfig {
  const baseUrl = normalizeBaseUrl(env.GROK_BASE_URL || "");
  const apiKey = (env.GROK_API_KEY || "").trim();
  const model = (overrides.model || env.GROK_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const timeoutSeconds = clampTimeoutSeconds(
    overrides.timeoutSeconds ??
      Number.parseFloat(env.GROK_TIMEOUT_SECONDS || ""),
  );

  const extraBody = {
    ...parseJsonObject(env.GROK_EXTRA_BODY_JSON),
    ...parseJsonObject(overrides.extraBodyJson),
  };

  const extraHeadersRaw = parseJsonObject(env.GROK_EXTRA_HEADERS_JSON);
  const extraHeadersOverride = parseJsonObject(overrides.extraHeadersJson);
  const extraHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...extraHeadersRaw, ...extraHeadersOverride })) {
    if (isBlockedExtraHeader(key)) {
      continue;
    }
    if (typeof value === "string") {
      extraHeaders[key] = value;
    } else {
      extraHeaders[key] = JSON.stringify(value);
    }
  }

  return { baseUrl, apiKey, model, timeoutSeconds, extraBody, extraHeaders };
}

async function runGrokQuery(
  query: string,
  env: Env,
  overrides: {
    model?: string;
    timeoutSeconds?: number;
    extraBodyJson?: string;
    extraHeadersJson?: string;
  },
): Promise<Record<string, JsonValue>> {
  const started = Date.now();
  const config = buildGrokConfig(env, overrides);

  if (!config.baseUrl) {
    return { ok: false, error: "missing_base_url", detail: "Set GROK_BASE_URL on the server." };
  }
  if (!config.apiKey) {
    return { ok: false, error: "missing_api_key", detail: "Set GROK_API_KEY on the server." };
  }

  const body: Record<string, JsonValue> = {
    model: config.model,
    messages: [
      {
        role: "system",
        content:
          "You are a web research assistant. Use live web search/browsing when answering. " +
          "Return ONLY a single JSON object with keys: " +
          "content (string), sources (array of objects with url/title/snippet when possible). " +
          "Keep content concise and evidence-backed.",
      },
      { role: "user", content: query },
    ],
    temperature: 0.2,
    ...config.extraBody,
    stream: false,
  };

  const headers = new Headers({
    "Content-Type": "application/json",
    Authorization: `Bearer ${config.apiKey}`,
  });
  for (const [key, value] of Object.entries(config.extraHeaders)) {
    headers.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutSeconds * 1000);

  try {
    const response = await fetch(`${config.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const rawText = await response.text();
    if (!response.ok) {
      return {
        ok: false,
        error: "upstream_http_error",
        status: response.status,
        status_text: response.statusText,
        detail: truncateText(rawText),
        ...upstreamConfigured(),
        model: config.model,
        timeout_seconds: config.timeoutSeconds,
        elapsed_ms: Date.now() - started,
      };
    }

    const parsedPayload = parseCompletionPayload(rawText);
    if (!parsedPayload.payload) {
      return {
        ok: false,
        error: "upstream_invalid_json",
        detail: parsedPayload.detail ?? "Unable to parse upstream response.",
        raw: parsedPayload.raw ?? truncateText(rawText),
        ...upstreamConfigured(),
        model: config.model,
        timeout_seconds: config.timeoutSeconds,
        elapsed_ms: Date.now() - started,
      };
    }
    const payload = parsedPayload.payload;

    let message = "";
    try {
      const choice = (payload.choices ?? [])[0] ?? {};
      const msg = choice.message ?? {};
      message = msg.content ?? "";
    } catch {}

    const parsed = coerceJsonObject(message);
    const sources: Array<Record<string, JsonValue>> = [];
    let content = "";
    let raw = "";

    if (parsed) {
      content = String(parsed.content ?? "");
      const src = parsed.sources;
      if (Array.isArray(src)) {
        for (const item of src) {
          if (item && typeof item === "object" && "url" in item) {
            sources.push({
              url: String((item as Record<string, JsonValue>).url ?? ""),
              title: String((item as Record<string, JsonValue>).title ?? ""),
              snippet: String((item as Record<string, JsonValue>).snippet ?? ""),
            });
          }
        }
      }
      if (sources.length === 0) {
        for (const url of extractUrls(content)) {
          sources.push({ url, title: "", snippet: "" });
        }
      }
    } else {
      raw = message;
      for (const url of extractUrls(message)) {
        sources.push({ url, title: "", snippet: "" });
      }
    }

    return {
      ok: true,
      query,
      ...upstreamConfigured(),
      model: payload.model ?? config.model,
      content,
      sources,
      raw,
      usage: payload.usage ?? {},
      response_format: payload.response_format ?? "json",
      timeout_seconds: config.timeoutSeconds,
      elapsed_ms: Date.now() - started,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: "request_failed",
      detail,
      ...upstreamConfigured(),
      model: config.model,
      timeout_seconds: config.timeoutSeconds,
      elapsed_ms: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildToolResult(result: Record<string, JsonValue>): Record<string, JsonValue> {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(limit, items.length);

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

async function handleJsonRpcMessage(
  message: Record<string, JsonValue>,
  env: Env,
): Promise<Record<string, JsonValue> | null> {
  const id = message.id ?? null;
  const method = message.method;
  const params = message.params as Record<string, JsonValue> | undefined;

  if (message.jsonrpc !== "2.0" || typeof method !== "string") {
    return {
      jsonrpc: "2.0",
      id,
      error: { code: -32600, message: "Invalid Request" },
    };
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "initialize") {
    const requested = (params?.protocolVersion as string | undefined) ?? PROTOCOL_VERSION;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: requested,
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        capabilities: { tools: { listChanged: false } },
      },
    };
  }

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: [
          {
            name: "grok_search",
            description: "Grok web research tool (public service).",
            inputSchema: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query or research task." },
                model: { type: "string", description: "Model name (optional)." },
                timeout_seconds: { type: "number", description: "Timeout in seconds (optional)." },
                extra_body_json: { type: "string", description: "Extra request body JSON (optional)." },
                extra_headers_json: { type: "string", description: "Extra request headers JSON (optional)." },
              },
              required: ["query"],
            },
          },
        ],
      },
    };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = params?.arguments as Record<string, JsonValue> | undefined;
    if (name !== "grok_search") {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Tool not found" },
      };
    }
    const query = typeof args?.query === "string" ? args.query.trim() : "";
    if (!query) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: "Missing required argument: query" },
      };
    }

    const result = await runGrokQuery(query, env, {
      model: typeof args?.model === "string" ? (args.model as string) : undefined,
      timeoutSeconds: typeof args?.timeout_seconds === "number" ? (args.timeout_seconds as number) : undefined,
      extraBodyJson: typeof args?.extra_body_json === "string" ? (args.extra_body_json as string) : undefined,
      extraHeadersJson: typeof args?.extra_headers_json === "string" ? (args.extra_headers_json as string) : undefined,
    });

    return {
      jsonrpc: "2.0",
      id,
      result: buildToolResult(result),
    };
  }

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: "Method not found" },
  };
}

async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get("Origin");
  const allowedOrigins = parseAllowedOrigins(env.ALLOWED_ORIGINS);
  const headers = corsHeaders(origin, allowedOrigins);
  if (origin && !isOriginAllowed(origin, allowedOrigins)) {
    return textResponse("Forbidden", 403, headers);
  }

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers });
  }

  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!env.GROK_PUBLIC_TOKEN || token !== env.GROK_PUBLIC_TOKEN) {
    return jsonResponse(
      { jsonrpc: "2.0", id: null, error: { code: 401, message: "Unauthorized" } },
      401,
      headers,
    );
  }

  if (request.method !== "POST") {
    return textResponse("Method Not Allowed", 405, headers);
  }

  const rawText = await request.text();
  let payload: JsonValue;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400, headers);
  }

  if (Array.isArray(payload)) {
    const results = await mapWithConcurrency(payload, BATCH_CONCURRENCY, async (item) => {
      if (!item || typeof item !== "object") {
        return { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } };
      }
      const result = await handleJsonRpcMessage(item as Record<string, JsonValue>, env);
      return result;
    });
    const responses = results.filter((result): result is Record<string, JsonValue> => result !== null);
    if (responses.length === 0) {
      return new Response(null, { status: 204, headers });
    }
    return jsonResponse(responses, 200, headers);
  }

  if (!payload || typeof payload !== "object") {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400, headers);
  }

  const result = await handleJsonRpcMessage(payload as Record<string, JsonValue>, env);
  if (!result) {
    return new Response(null, { status: 204, headers });
  }
  return jsonResponse(result, 200, headers);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return textResponse("grok-search-mcp worker is running.");
    }

    if (!MCP_PATHS.has(url.pathname)) {
      return textResponse("Not Found", 404);
    }

    return handleMcpRequest(request, env);
  },
};
