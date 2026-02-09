# grok-search-mcp (Cloudflare Worker)

## 部署（本地 wrangler）

1) 设置 Worker Secrets：

```powershell
npx wrangler secret put GROK_BASE_URL
npx wrangler secret put GROK_API_KEY
npx wrangler secret put GROK_PUBLIC_TOKEN
```

2) 部署：

```powershell
npx wrangler deploy
```

可选环境变量：
`GROK_MODEL`, `GROK_TIMEOUT_SECONDS`, `GROK_EXTRA_BODY_JSON`, `GROK_EXTRA_HEADERS_JSON`, `ALLOWED_ORIGINS`

## 本地调试

```powershell
copy .dev.vars.example .dev.vars
npx wrangler dev
```

## GitHub Actions 自动部署

说明：推送到 `worker` 分支会自动部署。

需要在 GitHub 仓库 Secrets 中配置：
1) `CLOUDFLARE_API_TOKEN`：Cloudflare API Token（需有 Workers 部署权限）
2) `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 账号 ID（Dashboard -> Workers -> Overview 可见）
3) `GROK_BASE_URL`：上游 Grok 接口基础地址（如 `https://xxx.example`）
4) `GROK_API_KEY`：上游 Grok API Key
5) `GROK_PUBLIC_TOKEN`：对外访问令牌（MCP Host 的 Authorization Bearer）

示例 Git 流程：

```powershell
git checkout worker
git add -A
git commit -m "feat: update worker"
git push origin worker
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
