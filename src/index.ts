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
const DEFAULT_MODEL = "grok-2-latest";
const DEFAULT_TIMEOUT_SECONDS = 60;
const SERVER_NAME = "grok_search_worker";
const SERVER_VERSION = "0.1.0";
const PROTOCOL_VERSION = "2025-06-18";

function jsonResponse(body: JsonValue, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, {
    status,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    },
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
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, JsonValue>;
    }
  } catch {}
  return null;
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
  const timeoutSeconds =
    overrides.timeoutSeconds ??
    Number.parseFloat(env.GROK_TIMEOUT_SECONDS || "") ||
    DEFAULT_TIMEOUT_SECONDS;

  const extraBody = {
    ...parseJsonObject(env.GROK_EXTRA_BODY_JSON),
    ...parseJsonObject(overrides.extraBodyJson),
  };

  const extraHeadersRaw = parseJsonObject(env.GROK_EXTRA_HEADERS_JSON);
  const extraHeadersOverride = parseJsonObject(overrides.extraHeadersJson);
  const extraHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...extraHeadersRaw, ...extraHeadersOverride })) {
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
    stream: false,
    ...config.extraBody,
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
    const payload = JSON.parse(rawText);

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
      base_url: config.baseUrl,
      model: payload.model ?? config.model,
      content,
      sources,
      raw,
      usage: payload.usage ?? {},
      elapsed_ms: Date.now() - started,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      error: "request_failed",
      detail,
      base_url: config.baseUrl,
      model: config.model,
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
  if (origin && !isOriginAllowed(origin, allowedOrigins)) {
    return textResponse("Forbidden", 403);
  }

  const token = extractBearerToken(request.headers.get("Authorization"));
  if (!env.GROK_PUBLIC_TOKEN || token !== env.GROK_PUBLIC_TOKEN) {
    return jsonResponse(
      { jsonrpc: "2.0", id: null, error: { code: 401, message: "Unauthorized" } },
      401,
    );
  }

  if (request.method !== "POST") {
    return textResponse("Method Not Allowed", 405);
  }

  const rawText = await request.text();
  let payload: JsonValue;
  try {
    payload = JSON.parse(rawText);
  } catch {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
  }

  if (Array.isArray(payload)) {
    const responses: Record<string, JsonValue>[] = [];
    for (const item of payload) {
      if (!item || typeof item !== "object") {
        responses.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
        continue;
      }
      const result = await handleJsonRpcMessage(item as Record<string, JsonValue>, env);
      if (result) responses.push(result);
    }
    if (responses.length === 0) {
      return new Response(null, { status: 204 });
    }
    return jsonResponse(responses);
  }

  if (!payload || typeof payload !== "object") {
    return jsonResponse({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } }, 400);
  }

  const result = await handleJsonRpcMessage(payload as Record<string, JsonValue>, env);
  if (!result) {
    return new Response(null, { status: 204 });
  }
  return jsonResponse(result);
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
