# pi-web

[pi](https://github.com/earendil-works/pi) 编码代理的 Web 界面，Claude Desktop 风格。

- **进程内嵌 pi SDK**（`@earendil-works/pi-coding-agent` 1.4.0），直接持有 `AgentSession`，不走 RPC 子进程。
- 读取你本机的 pi 配置：`~/.pi/agent` 下的模型、凭据、设置、扩展、技能、提示模板与会话，和 `pi` CLI 共用会话记录。
- 内置 CLI 同款扩展：codemode、tool_search、MCP。为 CLI 写的扩展照常工作：`select / confirm / input / editor` 对话框、
  `notify`、`setStatus`、`setWidget`、`setWorkingMessage` 都映射到浏览器（与 pi 的 RPC 模式行为一致）。
- 默认监听 `0.0.0.0`，局域网内的手机/平板也能用；带令牌认证。

## 使用

```bash
npm install
npm run build
npm start                        # 0.0.0.0:30142
# 或
node bin/pi-web.js --port 8080 --cwd ~/code/my-project
```

启动后终端会打印带令牌的地址，例如 `http://192.168.1.10:30142/?token=…`，打开即可（令牌写入 cookie，之后不用再带）。 同时打印一个二维码：监听 0.0.0.0 时是第一个局域网地址，否则是 127.0.0.1 地址，手机或其他机器扫码即可打开/拿到令牌。

| 参数 | 环境变量 | 默认 |
|---|---|---|
| `--host` | `PI_WEB_HOST` | `0.0.0.0` |
| `--port` | `PI_WEB_PORT` | `30142` |
| `--cwd` | | 当前目录（新会话的默认工作区） |
| `--token` | `PI_WEB_TOKEN` | 首次启动生成并保存在 `~/.pi/agent/pi-web/token` |
| `--no-auth` | | 关闭认证。**代理能执行 bash，只在可信网络里这样做** |

## 开发

```bash
npm run dev        # API :30142（tsx watch）+ Vite :5173（0.0.0.0，/api 代理到后端）
npm test           # vitest：server/ 与 web/ 的单测（服务端用 pi-ai 的 faux 模型，不联网）
npm run typecheck
```

组件演示页（Vite dev 下）：`/demo-transcript.html`、`/demo-composer.html`，加 `?theme=dark` 看暗色。

文档：[架构](docs/ARCHITECTURE.md) · [视觉与交互规范](docs/DESIGN.md) · 前后端契约 [`shared/protocol.ts`](shared/protocol.ts)

## 致谢

- 视觉参考 [dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)（MIT）的 Claude 色卡与布局，及其基底 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。
- 服务端参考了 [agegr/pi-web](https://github.com/agegr/pi-web)（基于 pi 1.2.0）的 SDK 嵌入方式。
- 字体：Inter、Noto Serif（SIL OFL）。
