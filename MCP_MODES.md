# MCP 服务模式说明（本地 vs 远程）

## 一句话总结

- **本地 MCP（stdio 进程）**：MCP Host 在本机启动一个进程，通过 stdin/stdout 通信。
- **远程 MCP（HTTP/SSE）**：MCP Host 直接连接远程 URL，不在本机启动进程。

---

## 模式 A：本地 MCP（stdio 进程）

**特点**
- Host 启动进程（`command/args/env`）。
- Host 通过 `type: "stdio"` 与进程通信。
- 进程内部可以访问任何远程 API（例如 Upstash/Context7）。

**示例**
```json
{
  "command": "cmd",
  "args": ["/c","npx","-y","@upstash/context7-mcp","--api-key","ctx***"],
  "type": "stdio"
}
```

**适用**
- 每个用户自己在本机跑一个 MCP。
- 用户各自配置 API Key。

---

## 模式 B：远程 MCP（HTTP/SSE）

**特点**
- Host 不启动进程。
- Host 直接连 URL（`type: "http"` 或 `type: "sse"`）。
- MCP 服务跑在远程服务器上（公共服务）。

**示例**
```json
{
  "type": "http",
  "url": "http://your-server:8000/mcp/"
}
```

**适用**
- 统一部署一套 MCP 服务。
- 多个用户共享同一服务端。

---

## 容易混淆的点

**“本地 MCP + 远程 API” != “远程 MCP 服务”**

例如 Context7：
- MCP 服务本身是本地进程（stdio）。
- 只是它调用的 API 在远程。

---

## 你目前的选择

你要的是 **公共服务**，即 **模式 B（远程 MCP）**。
只需要部署服务一次，用户只配置 URL 即可。
