# pi-web

[![npm](https://img.shields.io/npm/v/@vauntlek/pi-web?color=d97757)](https://www.npmjs.com/package/@vauntlek/pi-web)
[![node](https://img.shields.io/node/v/@vauntlek/pi-web)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@vauntlek/pi-web)](LICENSE)
[![CI](https://github.com/VauntlekV/pi-web/actions/workflows/ci.yml/badge.svg)](https://github.com/VauntlekV/pi-web/actions/workflows/ci.yml)
[![demo](https://img.shields.io/badge/demo-在线体验-d97757)](https://vauntlekv.github.io/pi-web/)

[pi](https://github.com/earendil-works/pi) 编码代理的 Web 界面，在浏览器里使用 pi，桌面和手机都可以。

pi-web 在进程内嵌入 pi SDK（`@earendil-works/pi-coding-agent` 1.4.0），直接持有 `AgentSession`，不经过 RPC 子进程。它与 `pi` CLI 共用 `~/.pi/agent` 下的模型、凭据、设置、扩展、技能和会话，所以 CLI 里的会话可以在网页里接着聊，反之亦然。界面参考 [dsh-claude-style](https://github.com/Nwflower/dsh-claude-style) 的 Claude 风格。

**[在线演示](https://vauntlekv.github.io/pi-web/)**：真实前端加上从真实服务端录制的回放数据（模拟模型、示例 Git 仓库），可以点开会话、文件和 Git 面板，发消息会回放一轮录好的对话；写操作是只读的。

![对话、工作步骤与右侧 Git 面板](https://raw.githubusercontent.com/VauntlekV/pi-web/main/docs/images/conversation-light.png)

## 特性

- **对话**：每一轮的思考与工具调用折叠成「已完成，用时 N 秒 → 执行 X 次思考，调用 Y 次工具 → 每一步」，答案留在折叠外；右侧边缘有对话导航，可在各轮之间跳转；「轨迹」视图按时间线列出每条消息与工具调用。
- **右侧栏**：「文件」与「Git」两个标签。文件树带 Git 状态标记；可预览代码（行号、高亮）、Markdown 和图片；Git 面板支持查看 diff、暂存 / 取消暂存、提交（可用当前会话的模型生成提交信息）、拉取 / 推送，并以分支图展示提交历史。左右两侧栏都可以拖动调宽。
- **设置**：主题、字号、工作步骤展示方式；pi 自身的设置（思考档位、自动压缩、自动重试等，和 CLI 写同一份 `settings.json`）；模型与 API Key，以及 `models.json` 的可视化编辑（改内置模型的上下文、输出上限、价格、思考档位映射；添加 OpenAI / Anthropic / Google 兼容的自定义提供商，从接口拉取模型列表，一键测试连通性）；扩展、技能与提示模板的启用开关；npm / git 包的安装、更新和卸载。
- **动效**：照 dsh-claude-style 的「动效」页实现，包括随系统 / 减弱 / 总是三档总开关、平滑跟随滚动、带扫光或渐变流动的状态行、滑动光标、新文字淡入和消息气泡入场。
- **扩展兼容**：内置与 CLI 相同的 codemode、tool_search、MCP 扩展。为 CLI 写的扩展照常工作，`select / confirm / input / editor` 对话框以及 `notify`、`setStatus`、`setWidget`、`setWorkingMessage` 都会显示在浏览器里。
- **多设备**：默认监听 `0.0.0.0`，使用令牌认证；启动时终端会打印带令牌的链接和二维码，手机扫码即可打开。多个标签页可以同时打开同一个会话，状态实时同步。

## 安装

需要 Node.js ≥ 22.19。

```bash
npm install -g @vauntlek/pi-web
```

不必先装 `pi` CLI。如果之前用过 pi，现有的模型、凭据和会话会直接读进来；没用过的话，启动后在「设置 › 模型」里填一个 API Key 就能开始。

## 使用

```bash
cd ~/code/my-project
pi-web
```

```text
pi-web 已启动: http://127.0.0.1:30142/?token=3f9c…
  http://192.168.1.10:30142/?token=3f9c…

扫码打开 http://192.168.1.10:30142/?token=3f9c…
█▀▀▀▀▀█ ▄▀▄ █▀▀▀▀▀█
…
```

打开任意一个链接即可。第一次访问后令牌会存进 cookie，之后直接访问 `http://<主机>:30142/` 就行。令牌在首次启动时生成，保存在 `~/.pi/agent/pi-web/token`，之后每次启动都相同。

| 参数 | 环境变量 | 默认 |
|---|---|---|
| `--host <addr>` | `PI_WEB_HOST` | `0.0.0.0` |
| `--port <n>` | `PI_WEB_PORT` | `30142` |
| `--cwd <dir>` | | 当前目录，作为新会话的默认工作区 |
| `--token <t>` | `PI_WEB_TOKEN` | 首次启动时生成并保存 |
| `--no-auth` | | 关闭认证 |
| `-h, --help` / `-v, --version` | | |

> [!WARNING]
> 代理可以在这台机器上读写文件、执行命令。令牌等同于这台机器的 shell 权限，请只在可信网络中开放端口；`--no-auth` 只适合完全可信的环境。需要公网访问时，请放在 VPN 或带认证的反向代理之后。

## 截图

| 暗色 · 文件预览 | 轨迹视图 |
|---|---|
| ![暗色主题下的对话与文件预览](https://raw.githubusercontent.com/VauntlekV/pi-web/main/docs/images/conversation-dark.png) | ![轨迹视图](https://raw.githubusercontent.com/VauntlekV/pi-web/main/docs/images/trajectory-dark.png) |
| **首页 · 用量统计** | **设置 › 动效** |
| ![首页](https://raw.githubusercontent.com/VauntlekV/pi-web/main/docs/images/home-light.png) | ![动效设置](https://raw.githubusercontent.com/VauntlekV/pi-web/main/docs/images/settings-motion.png) |

<p align="center">
  <img src="https://raw.githubusercontent.com/VauntlekV/pi-web/main/docs/images/mobile.png" alt="手机" width="300" />
</p>

## 与 pi CLI 的关系

| | pi CLI | pi-web |
|---|---|---|
| 配置目录 | `~/.pi/agent` | 同一个 |
| 会话记录 | `~/.pi/agent/sessions` | 同一份，可以互相续聊 |
| 模型与 API Key | `/login`、`models.json` | 同一份；也能在「设置 › 模型」里修改 |
| 扩展 / 技能 / 提示模板 | `pi config`、`pi install` | 同一份；在「插件」页可以启用、停用和安装 |
| OAuth 登录 | `/login` | 暂不支持，需要先在 CLI 中完成 |

## 开发

```bash
git clone https://github.com/VauntlekV/pi-web.git && cd pi-web
npm install
npm run dev        # API :30142（tsx watch）+ Vite :5173，/api 代理到后端
npm test           # vitest；服务端测试用 pi-ai 的 faux 模型，不联网
npm run typecheck
npm run test:e2e   # Playwright，跑在 e2e/fixture.ts 的模拟模型和示例仓库上（首次需 npx playwright install chromium）
npm run build:demo # GitHub Pages 演示站点 → dist/pages
npm run build && npm start
```

GitHub Actions：`CI` 在每次推送和 PR 上跑类型检查、构建、单元测试（Ubuntu / macOS × Node 22.19 / 24）、打包安装冒烟测试和 E2E；`Demo site` 在 main 上部署演示站点；发版流程见 [docs/RELEASING.md](docs/RELEASING.md)。

前后端契约在 [`shared/protocol.ts`](shared/protocol.ts)，架构说明见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)，视觉与交互规范见 [docs/DESIGN.md](docs/DESIGN.md)。

## 致谢

- 界面与动效参考 [dsh-claude-style](https://github.com/Nwflower/dsh-claude-style)（MIT）及其基底 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；状态行的渐变流动和文字换场来自 [transitions.dev](https://transitions.dev)。详见 [第三方声明](docs/THIRD_PARTY_NOTICES.md)。
- 服务端的 SDK 嵌入方式参考了 [agegr/pi-web](https://github.com/agegr/pi-web)。
- 字体：Inter、Noto Serif（SIL OFL）。

## 许可

[MIT](LICENSE)
