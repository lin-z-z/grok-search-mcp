# grok-search-mcp (Cloudflare Worker)

## 部署

先配置机密（Secrets）：

```powershell
npx wrangler secret put GROK_BASE_URL
npx wrangler secret put GROK_API_KEY
npx wrangler secret put GROK_PUBLIC_TOKEN
```

可选环境变量：
`GROK_MODEL`, `GROK_TIMEOUT_SECONDS`, `GROK_EXTRA_BODY_JSON`, `GROK_EXTRA_HEADERS_JSON`, `ALLOWED_ORIGINS`

部署：

```powershell
npx wrangler deploy
```

## 本地调试

```powershell
copy .dev.vars.example .dev.vars
npx wrangler dev
```

## MCP Host 配置（mcpServers 风格）

```json
{
  "mcpServers": {
    "grok-search": {
      "url": "https://your-worker.your-domain.workers.dev/mcp/",
      "transportType": "streamable-http",
      "timeout": 600,
      "headers": {
        "Authorization": "Bearer your-access-token"
      }
    }
  }
}
```

## 工具调用参数

```json
{
  "tool": "grok_search",
  "args": {
    "query": "今天有什么新消息？",
    "model": "grok-2-latest",
    "timeout_seconds": 60
  }
}
```

## 安全说明

- 服务端强制校验 `Authorization`（必须等于 `GROK_PUBLIC_TOKEN`）
- 建议设置 `ALLOWED_ORIGINS` 限制来源
- 上游 Grok 凭据仅保存在 Worker Secrets 中
