# pi-web 架构

pi-web 是 [pi](https://github.com/earendil-works/pi) 编码代理的 Web 界面。服务端在**同一个 Node 进程里**内嵌 pi SDK
（`@earendil-works/pi-coding-agent` 1.4.0），直接持有 `AgentSession` 对象，不启动 `pi --mode rpc` 子进程。
浏览器通过 HTTP + SSE 与之通信。

```
 browser (React)                          node process
┌──────────────────┐   JSON / HTTP   ┌──────────────────────────────────────────────┐
│ api/client.ts    │ ──────────────▶ │ app.ts (Hono)  ── auth.ts                   │
│ useSessionStream │ ◀── SSE ─────── │   │                                         │
│ session-reducer  │                 │ registry.ts ── LiveSession ×N               │
│ Transcript       │                 │                  │ AgentSession (pi SDK)    │
│ Composer         │                 │                  │  ├ ModelRuntime          │
└──────────────────┘                 │                  │  ├ SessionManager (.jsonl)│
                                     │                  │  ├ extensions (用户的 +  │
                                     │                  │  │  codemode/tool_search/ │
                                     │                  │  │  mcp 内置)             │
                                     │                  │  └ uiContext ⇄ 浏览器对话框│
                                     └──────────────────────────────────────────────┘
```

## 契约

`shared/protocol.ts` 是前后端唯一的契约：消息类型、`SessionState`、SSE `ServerEvent`、全部路由。两边都只从这里取类型。

## 服务端（server/）

- **registry.ts**：live 会话表。按 id 创建/复活（`SessionManager.open`），空闲 10 分钟且无订阅者时 dispose。工作区列表 = 磁盘会话 + 尚未落盘的 live 会话，按 cwd 分组。
- **live-session.ts**：包装一个 `AgentSession`。
  - `session.subscribe()` 的事件映射为 `ServerEvent` 广播给所有 SSE 客户端；`message_update` 节流到 ~20/s，发完整 partial 消息，客户端直接替换。新客户端先收到 `snapshot`，断线重连无需补发。
  - 扩展 UI 桥：`bindExtensions({ uiContext, mode: "rpc" })`。`select/confirm/input/editor` 变成 `ui_request` 事件，浏览器回答后 resolve；超时/中断自动取消。`notify/setStatus/setWidget(string[])/setWorkingMessage` 进入 `SessionState`。TUI 专属接口（`custom()`、自定义组件）为空实现——与 pi 自己的 RPC 模式一致，所以为 CLI 写的扩展（如 ask_user_question）走对话框降级路径照常工作。
  - 自动标题：首轮结束后用当前模型生成标题，失败回退为首条消息。
- **auth.ts**：令牌认证（cookie 或 Bearer）。监听 0.0.0.0 时局域网可达，而代理能执行 bash，所以默认开启；令牌持久化在 `~/.pi/agent/pi-web/token`。
- **SDK 定制点**：`createAgentSessionServices` 的 `resourceLoaderOptions.extensionFactories` 注入 CLI 同款内置扩展；`ModelRuntime` 每会话一份（扩展注册的 provider 可见），模型列表接口优先用会话自己的。

## 浏览器（web/）

- **state/session-reducer.ts**：`applyEvent(view, event)` 纯函数，SSE 事件 → 视图状态。
- **transcript/**：对话渲染（Markdown、思考、工具卡片、diff）。
- **composer/**：输入框（模型/思考档位、`/` 命令、`@` 文件、图片、排队/插话）。
- 其余：侧栏（工作区/会话）、首页、对话页、扩展对话框、登录页。
- 视觉：`docs/DESIGN.md`，令牌在 `web/src/styles/tokens.css`。

## 运行

```bash
npm run dev            # API :30142（tsx watch，仅 127.0.0.1）+ Vite :5173（0.0.0.0，代理 /api）
npm run build && npm start   # 生产：单进程 0.0.0.0:30142，同时提供静态页面
node bin/pi-web.js --port 8080 --cwd ~/code/foo
```
