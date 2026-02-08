import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from typing import Any

from mcp.server.fastmcp import FastMCP
from mcp.server.dependencies import get_http_headers


def _compact_json(data: Any) -> str:
    """
    将对象序列化为紧凑 JSON 字符串。

    Args:
        data: 任意可 JSON 序列化对象。

    Returns:
        紧凑的 JSON 字符串。
    """
    return json.dumps(data, ensure_ascii=False, separators=(",", ":"), sort_keys=False)


def _skill_root() -> str:
    """
    获取当前服务根目录。

    Returns:
        服务根目录的绝对路径。
    """
    return os.path.abspath(os.path.dirname(__file__))


def _load_dotenv(path: str) -> None:
    """
    读取 .env 文件并写入环境变量（不覆盖已存在的变量）。

    Args:
        path: .env 文件路径。
    """
    if not os.path.exists(path):
        return
    try:
        with open(path, "r", encoding="utf-8") as file:
            for raw_line in file:
                line = raw_line.strip()
                if not line or line.startswith("#"):
                    continue
                if line.startswith("export "):
                    line = line[len("export ") :].strip()
                if "=" not in line:
                    continue
                key, value = line.split("=", 1)
                key = key.strip()
                value = value.strip()
                if not key or key in os.environ:
                    continue
                if (value.startswith('"') and value.endswith('"')) or (
                    value.startswith("'") and value.endswith("'")
                ):
                    value = value[1:-1]
                os.environ[key] = value
    except OSError:
        return


_load_dotenv(os.path.join(_skill_root(), ".env"))


def _normalize_api_key(api_key: str) -> str:
    """
    规范化 API Key，过滤占位符。

    Args:
        api_key: 原始 API Key。

    Returns:
        可用的 API Key，若无效则返回空字符串。
    """
    api_key = api_key.strip()
    if not api_key:
        return ""
    placeholder = {"YOUR_API_KEY", "API_KEY", "CHANGE_ME", "REPLACE_ME"}
    if api_key.upper() in placeholder:
        return ""
    return api_key


def _normalize_base_url_value(base_url: str) -> str:
    """
    规范化 Base URL，过滤占位符。

    Args:
        base_url: 原始 Base URL。

    Returns:
        可用的 Base URL，若无效则返回空字符串。
    """
    base_url = base_url.strip()
    if not base_url:
        return ""
    placeholder = {
        "https://your-grok-endpoint.example",
        "YOUR_BASE_URL",
        "BASE_URL",
        "CHANGE_ME",
        "REPLACE_ME",
    }
    if base_url.upper() in placeholder:
        return ""
    return base_url


def _normalize_base_url(base_url: str) -> str:
    """
    清理 Base URL 尾部斜杠与 /v1。

    Args:
        base_url: 原始 Base URL。

    Returns:
        规范化后的 Base URL。
    """
    base_url = base_url.strip().rstrip("/")
    if base_url.endswith("/v1"):
        return base_url[: -len("/v1")]
    return base_url


def _coerce_json_object(text: str) -> dict[str, Any] | None:
    """
    将字符串尝试解析为 JSON 对象。

    Args:
        text: 输入文本。

    Returns:
        解析得到的对象字典；失败时返回 None。
    """
    text = text.strip()
    if not text:
        return None
    if text.startswith("{") and text.endswith("}"):
        try:
            value = json.loads(text)
            return value if isinstance(value, dict) else None
        except json.JSONDecodeError:
            return None
    return None


def _extract_urls(text: str) -> list[str]:
    """
    从文本中提取 URL 列表。

    Args:
        text: 输入文本。

    Returns:
        去重后的 URL 列表。
    """
    urls = re.findall(r"https?://[^\s)\]}>\"']+", text)
    seen: set[str] = set()
    out: list[str] = []
    for url in urls:
        url = url.rstrip(".,;:!?'\"")
        if url and url not in seen:
            seen.add(url)
            out.append(url)
    return out


def _load_json_env(var_name: str) -> dict[str, Any]:
    """
    从环境变量读取 JSON 对象。

    Args:
        var_name: 环境变量名。

    Returns:
        JSON 对象字典；变量不存在时返回空字典。

    Raises:
        ValueError: 变量内容不是 JSON 对象。
    """
    raw = os.environ.get(var_name, "").strip()
    if not raw:
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{var_name} must be a JSON object")
    return value


def _parse_json_object(raw: str, *, label: str) -> dict[str, Any]:
    """
    解析 JSON 对象字符串。

    Args:
        raw: JSON 字符串。
        label: 错误提示标签。

    Returns:
        JSON 对象字典；空字符串返回空字典。

    Raises:
        ValueError: 不是 JSON 对象。
    """
    raw = raw.strip()
    if not raw:
        return {}
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ValueError(f"{label} must be a JSON object")
    return value


def _request_chat_completions(
    *,
    base_url: str,
    api_key: str,
    model: str,
    query: str,
    timeout_seconds: float,
    extra_headers: dict[str, Any],
    extra_body: dict[str, Any],
) -> dict[str, Any]:
    """
    调用 Grok 的 chat/completions 接口。

    Args:
        base_url: Grok 基础地址。
        api_key: Grok API Key。
        model: 模型名称。
        query: 查询文本。
        timeout_seconds: 超时时间（秒）。
        extra_headers: 额外请求头。
        extra_body: 额外请求体字段。

    Returns:
        Grok 接口原始响应对象。
    """
    url = f"{_normalize_base_url(base_url)}/v1/chat/completions"

    system = (
        "You are a web research assistant. Use live web search/browsing when answering. "
        "Return ONLY a single JSON object with keys: "
        "content (string), sources (array of objects with url/title/snippet when possible). "
        "Keep content concise and evidence-backed."
    )

    body: dict[str, Any] = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": query},
        ],
        "temperature": 0.2,
        "stream": False,
    }
    body.update(extra_body)

    headers: dict[str, str] = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {api_key}",
    }
    for key, value in extra_headers.items():
        headers[str(key)] = str(value)

    req = urllib.request.Request(
        url=url,
        data=_compact_json(body).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        raw = resp.read().decode("utf-8", errors="replace")
        return json.loads(raw)


def _build_search_result(
    *,
    query: str,
    base_url: str,
    model: str,
    resp: dict[str, Any],
    elapsed_ms: int,
) -> dict[str, Any]:
    """
    将模型响应转换为标准返回结构。

    Args:
        query: 查询文本。
        base_url: Grok 基础地址。
        model: 模型名称。
        resp: 原始响应对象。
        elapsed_ms: 耗时毫秒数。

    Returns:
        标准化响应字典。
    """
    message = ""
    try:
        choice0 = (resp.get("choices") or [{}])[0]
        msg = choice0.get("message") or {}
        message = msg.get("content") or ""
    except Exception:
        message = ""

    parsed = _coerce_json_object(message)
    sources: list[dict[str, Any]] = []
    content = ""
    raw = ""

    if parsed is not None:
        content = str(parsed.get("content") or "")
        src = parsed.get("sources")
        if isinstance(src, list):
            for item in src:
                if isinstance(item, dict) and item.get("url"):
                    sources.append(
                        {
                            "url": str(item.get("url")),
                            "title": str(item.get("title") or ""),
                            "snippet": str(item.get("snippet") or ""),
                        }
                    )
        if not sources:
            for url in _extract_urls(content):
                sources.append({"url": url, "title": "", "snippet": ""})
    else:
        raw = message
        for url in _extract_urls(message):
            sources.append({"url": url, "title": "", "snippet": ""})

    return {
        "ok": True,
        "query": query,
        "base_url": base_url,
        "model": resp.get("model") or model,
        "content": content,
        "sources": sources,
        "raw": raw,
        "usage": resp.get("usage") or {},
        "elapsed_ms": elapsed_ms,
    }


def _grok_search(
    *,
    query: str,
    base_url: str | None,
    api_key: str | None,
    model: str | None,
    timeout_seconds: float | None,
    extra_body_json: str | None,
    extra_headers_json: str | None,
) -> dict[str, Any]:
    """
    执行一次检索请求（包含鉴权与配置解析）。

    Args:
        query: 查询文本。
        base_url: 上游地址（保留参数，不对外暴露）。
        api_key: 上游 API Key（保留参数，不对外暴露）。
        model: 模型名称。
        timeout_seconds: 超时时间（秒）。
        extra_body_json: 额外请求体 JSON 字符串。
        extra_headers_json: 额外请求头 JSON 字符串。

    Returns:
        标准化响应字典。
    """
    # 从环境变量中解析服务端默认值。
    base_url = _normalize_base_url_value(os.environ.get("GROK_BASE_URL", "").strip())
    api_key = _normalize_api_key(os.environ.get("GROK_API_KEY", "").strip())
    model = (os.environ.get("GROK_MODEL", "").strip() or model or "grok-2-latest")

    effective_timeout = timeout_seconds or 0.0
    if not effective_timeout:
        try:
            effective_timeout = float(os.environ.get("GROK_TIMEOUT_SECONDS", "0") or "0")
        except ValueError:
            effective_timeout = 0.0
    if not effective_timeout:
        effective_timeout = 60.0

    # 公共访问令牌（基于 Header 的鉴权），每次请求必填。
    public_token = os.environ.get("GROK_PUBLIC_TOKEN", "").strip()
    try:
        headers = get_http_headers()
    except Exception:
        headers = {}
    auth_header = headers.get("authorization") or headers.get("Authorization") or ""
    if not public_token:
        return {
            "ok": False,
            "error": "public_token_not_configured",
            "detail": "Set GROK_PUBLIC_TOKEN on the server.",
        }

    if not auth_header:
        return {
            "ok": False,
            "error": "missing_authorization",
            "detail": "Missing Authorization header.",
        }

    token = auth_header.strip()
    if token.lower().startswith("bearer "):
        token = token[7:].strip()

    if token != public_token:
        return {
            "ok": False,
            "error": "invalid_authorization",
            "detail": "Authorization token is invalid.",
        }

    # 确保上游 Grok 地址已在服务端配置。
    if not base_url:
        return {
            "ok": False,
            "error": "missing_base_url",
            "detail": "Set GROK_BASE_URL or configure base_url.",
        }

    if not api_key:
        return {
            "ok": False,
            "error": "missing_api_key",
            "detail": "Set GROK_API_KEY or configure api_key.",
        }

    try:
        extra_body: dict[str, Any] = {}
        extra_body.update(_load_json_env("GROK_EXTRA_BODY_JSON"))
        if extra_body_json is not None:
            extra_body.update(_parse_json_object(extra_body_json, label="extra_body_json"))

        extra_headers: dict[str, Any] = {}
        extra_headers.update(_load_json_env("GROK_EXTRA_HEADERS_JSON"))
        if extra_headers_json is not None:
            extra_headers.update(_parse_json_object(extra_headers_json, label="extra_headers_json"))
    except Exception as exc:
        return {
            "ok": False,
            "error": "invalid_json",
            "detail": str(exc),
        }

    started = time.time()
    try:
        resp = _request_chat_completions(
            base_url=base_url,
            api_key=api_key,
            model=model,
            query=query,
            timeout_seconds=effective_timeout,
            extra_headers=extra_headers,
            extra_body=extra_body,
        )
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace") if hasattr(exc, "read") else ""
        return {
            "ok": False,
            "error": f"HTTP {getattr(exc, 'code', None)}",
            "detail": raw or str(exc),
            "base_url": base_url,
            "model": model,
            "elapsed_ms": int((time.time() - started) * 1000),
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": "request_failed",
            "detail": str(exc),
            "base_url": base_url,
            "model": model,
            "elapsed_ms": int((time.time() - started) * 1000),
        }

    elapsed_ms = int((time.time() - started) * 1000)
    return _build_search_result(
        query=query,
        base_url=base_url,
        model=model,
        resp=resp,
        elapsed_ms=elapsed_ms,
    )


def _normalize_transport(value: str) -> str:
    """
    规范化传输方式名称。

    Args:
        value: 传输方式字符串。

    Returns:
        标准化后的传输方式；无效时返回空字符串。
    """
    transport = value.strip().lower()
    if transport in {"http", "streamable-http", "streamable_http"}:
        return "http"
    if transport in {"sse", "stdio"}:
        return transport
    return ""


def _parse_server_args() -> argparse.Namespace:
    """
    解析服务端启动参数。

    Returns:
        argparse.Namespace 实例。
    """
    parser = argparse.ArgumentParser(description="Grok MCP server")
    parser.add_argument(
        "--transport",
        default=os.environ.get("MCP_TRANSPORT", "stdio"),
        help="Transport: stdio, http, or sse. (env: MCP_TRANSPORT)",
    )
    parser.add_argument(
        "--host",
        default=os.environ.get("MCP_HOST", "127.0.0.1"),
        help="Bind host for HTTP/SSE. (env: MCP_HOST)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=int(os.environ.get("MCP_PORT", "8000")),
        help="Bind port for HTTP/SSE. (env: MCP_PORT)",
    )
    parser.add_argument(
        "--path",
        default=os.environ.get("MCP_PATH", "/mcp/"),
        help="HTTP MCP path for streamable-http transport. (env: MCP_PATH)",
    )
    parser.add_argument("--base-url", default="", help="Override Grok base URL.")
    parser.add_argument("--api-key", default="", help="Override Grok API key.")
    parser.add_argument("--model", default="", help="Override Grok model.")
    parser.add_argument("--timeout-seconds", type=float, default=0.0, help="Override Grok timeout (seconds).")
    parser.add_argument(
        "--extra-body-json",
        default="",
        help="Extra JSON object merged into Grok request body.",
    )
    parser.add_argument(
        "--extra-headers-json",
        default="",
        help="Extra JSON object merged into Grok request headers.",
    )
    return parser.parse_args()


app = FastMCP(
    server_name="grok_search",
    description=(
        "Grok web research via OpenAI-compatible endpoint. "
        "Configure with .env or GROK_* environment variables."
    ),
)

_SERVER_OVERRIDES: dict[str, Any] = {
    "base_url": None,
    "api_key": None,
    "model": None,
    "timeout_seconds": None,
    "extra_body_json": None,
    "extra_headers_json": None,
}


def _merge_override(value: Any, override: Any) -> Any:
    """
    合并覆盖值，若当前值为空则使用覆盖值。

    Args:
        value: 当前值。
        override: 覆盖值。

    Returns:
        合并后的值。
    """
    return value if value not in (None, "") else override


@app.tool()
def grok_search(
    query: str,
    model: str | None = None,
    timeout_seconds: float | None = None,
    extra_body_json: str | None = None,
    extra_headers_json: str | None = None,
) -> dict[str, Any]:
    """
    执行 Grok 网络检索并返回结构化 JSON。

    Args:
        query: 查询文本或研究任务。
        model: 模型名称（可选）。
        timeout_seconds: 超时时间（秒，可选）。
        extra_body_json: 合并到请求体的 JSON 字符串（可选）。
        extra_headers_json: 合并到请求头的 JSON 字符串（可选）。

    Returns:
        结构化结果字典（包含 ok/content/sources 等）。
    """
    return _grok_search(
        query=query,
        base_url=_SERVER_OVERRIDES["base_url"],
        api_key=_SERVER_OVERRIDES["api_key"],
        model=_merge_override(model, _SERVER_OVERRIDES["model"]),
        timeout_seconds=_merge_override(timeout_seconds, _SERVER_OVERRIDES["timeout_seconds"]),
        extra_body_json=_merge_override(extra_body_json, _SERVER_OVERRIDES["extra_body_json"]),
        extra_headers_json=_merge_override(extra_headers_json, _SERVER_OVERRIDES["extra_headers_json"]),
    )


if __name__ == "__main__":
    args = _parse_server_args()
    transport = _normalize_transport(args.transport)
    if not transport:
        raise SystemExit("Invalid transport. Use: stdio, http, or sse.")

    _SERVER_OVERRIDES["base_url"] = args.base_url or None
    _SERVER_OVERRIDES["api_key"] = args.api_key or None
    _SERVER_OVERRIDES["model"] = args.model or None
    _SERVER_OVERRIDES["timeout_seconds"] = args.timeout_seconds or None
    _SERVER_OVERRIDES["extra_body_json"] = args.extra_body_json or None
    _SERVER_OVERRIDES["extra_headers_json"] = args.extra_headers_json or None

    # 根据 CLI/环境选择传输方式：HTTP/SSE 用于远程，stdio 用于本地。
    if transport == "stdio":
        app.run(transport="stdio")
    elif transport == "http":
        app.run(transport="http", host=args.host, port=args.port, path=args.path)
    else:
        app.run(transport="sse", host=args.host, port=args.port)
