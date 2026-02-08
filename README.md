# grok-search-mcp

## 本地启动

先复制 `.env.example` 为 `.env` 并填写你的配置。

```powershell
python mcp_server.py --transport http --host 0.0.0.0 --port 8000 --path /mcp/
```

## Docker 启动

```powershell
docker build -t grok-search-mcp .
docker run --rm -it -p 8000:8000 ^
  --env-file .env ^
  -e MCP_TRANSPORT="http" ^
  -e MCP_HOST="0.0.0.0" ^
  -e MCP_PORT="8000" ^
  -e MCP_PATH="/mcp/" ^
  grok-search-mcp
```

## Docker Compose 启动

先复制 `.env.example` 为 `.env` 并填写你的配置。

```powershell
docker compose up --build
```

## MCP 参数设置

### 工具调用参数

```json
{
  "tool": "grok_search",
  "args": {
    "query": "今天有什么新消息？"
  }
}
```

说明：上游 `base_url/api_key` 由服务端 `.env` 配置，用户不需要也不能在调用时传入。

### MCP Host 远程配置（mcpServers 风格）

```json
{
  "mcpServers": {
    "grok-search": {
      "url": "http://your-server:8000/mcp/",
      "transportType": "streamable-http",
      "timeout": 600,
      "headers": {
        "Authorization": "Bearer your-access-token"
      }
    }
  }
}
```

说明：服务端会校验 `Authorization`，与 `GROK_PUBLIC_TOKEN` 一致才能调用。
