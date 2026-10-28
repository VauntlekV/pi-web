# pi-web 视觉与交互规范

视觉目标：Claude Code Desktop 风格，具体参照 [dsh-claude-style](https://github.com/Nwflower/dsh-claude-style) 的 "Claude" 色卡，
它叠在 [DeepSeek Harness web](https://github.com/deepseek-ai/deepseek-harness) 的布局上。参考截图（本地）：

- 首页：`<refs>/dsh-claude-style/docs/screenshots/claude-home-light.png`、`claude-home-dark.png`
- 对话：`<refs>/dsh-claude-style/docs/screenshots/claude-conversation-light.png`、`claude-conversation-dark.png`

`<refs>` = `/tmp/claude-1000/-home-elio-workbench-pr-pi-web/c33202a9-3bab-46eb-9aae-8a66d05a896d/scratchpad/refs`。
需要细节时可以读 `<refs>/dsh-claude-style/packages/client/src/features/**/*.css` 和 `theme/*.css`（它们是覆盖宿主 DOM 的选择器，**只借鉴数值，不照搬选择器**）。

不使用 Claude / Anthropic 的商标图形或文字。品牌是 **π**：强调色 `--accent` 的衬线 "π" 字形 + 衬线字标 "pi"。

## 令牌

所有颜色、字体、圆角、动效只从 `web/src/styles/tokens.css` 读（`var(--…)`），组件里不写字面颜色值。
亮/暗跟随系统，`<html data-theme="light|dark">` 可强制。新增令牌只能加到 tokens.css 且亮暗两套都给值。

关键语义：

| 用途 | 令牌 |
|---|---|
| 页面 / 对话列背景 | `--canvas` |
| 侧栏背景 | `--sidebar`，右边 `var(--hairline) solid var(--border-1)` |
| 主文字 / 次 / 三级 / 说明 | `--ink` / `--ink-2` / `--ink-3` / `--ink-4` |
| 卡片、代码块、表格、composer 的描边 | `--border-1`，圆角 `--radius-lg` |
| 用户气泡 | 背景 `--bubble`，圆角 `--radius-xl`，右对齐，最大宽 85% |
| hover 洗色 | `--hover-wash`；选中的侧栏行 `--hover-plate` |
| 强调（品牌、发送按钮、运行中圆点、焦点勾） | `--accent`，其上的文字 `--on-accent` |
| 行内代码 | 背景 `--code-wash`，文字 `--code-ink`，`--font-code` 0.9em，圆角 `--radius-xs`，padding 1px 4px |
| Markdown 链接 | `--link`，下划线 `--link-underline` |
| 弹层/菜单/对话框 | 背景 `--overlay`，`--shadow-2`，描边 `--border-1`，圆角 `--radius-lg`（对话框 `--radius-xl`） |

## 字体

- 界面：`--font-ui`，13–14px。
- 助手回答正文（Markdown）：`--font-prose`（拉丁文衬线、中文回落无衬线），`--text-base` 15px，行高 `--leading-prose`。
  h1 20px / h2 18px / h3 16px，粗 700，同样用 `--font-prose`。
- 代码：`--font-code` 13px。
- 品牌字标、会话标题（对话页顶栏）：`--font-brand`。

## 布局（v1，已废弃，以下方「dsh 结构」为准）

```
┌───────────── sidebar 280px ─────────────┬──────────────── main ────────────────────┐
│ π pi                         [⊟收起]    │ header 48px: 标题(衬线) · cwd chip … [···] │
│ (+) 新会话                              │                                          │
│                                         │      conversation column, max 744px,     │
│ 工作区                       [+目录]    │      居中, 左右 padding 24px               │
│ ▾ demo-project                          │                                          │
│   ∘ Markdown rendering tour   19分钟    │                                          │
│   ∘ Fix flaky onboarding…      1小时    │                                          │
│ ▸ notes-app                             │                                          │
│                                         │   ┌ composer (同宽, 底部吸附) ──────────┐ │
│                                         │   └─────────────────────────────────────┘ │
│ [主题]  [退出]                          │   模型 · 思考档位 · 用量        ◔ 23%     │
└─────────────────────────────────────────┴──────────────────────────────────────────┘
```

- 侧栏行高 30px，圆角 `--radius-md`，左右内边距 8px，会话行前有 4px 小圆点（`--ink-4`；运行中为 `--accent` 并呼吸动画；等待用户输入为 `--warn`），右侧相对时间 `--ink-4` 12px（刚刚 / N分钟 / N小时 / N天 / M月D日）。
- 窄屏（< 768px）：侧栏变为覆盖式抽屉（遮罩 + 滑入 `--dur-enter`），header 左侧出现汉堡按钮。
- 首页：上方 1/6 处一行问候语（π 字形 + "今天想做点什么？" `--text-hero` 衬线），中部「最近会话」卡片，底部 composer，composer 上方一行 chip：工作区（文件夹图标 + 目录名）。

## 交互与动效

- hover/press：`--dur-feedback` 过渡背景/颜色。弹层出现：opacity + translateY(4px) `--dur-enter` `--ease-out`。
- 新内容进入对话：opacity 淡入 `--dur-reveal`，不做位移。
- 运行中指示：一行 `--ink-3` 文字（默认"思考中…"/工具名/扩展 workingMessage），文字上有从左到右的明暗扫光（shimmer，`background-clip: text`，1.6s 循环）。
- 所有图标用 `lucide-react`，尺寸 16（工具栏 14），stroke 1.75，颜色继承。
- 文案用简体中文。

## 可访问性

- 所有图标按钮有 `aria-label` 和 `title`。
- 弹层：Esc 关闭，焦点进入首个可操作元素，关闭后焦点回到触发器。
- 列表型选择器（模型、slash、@文件、select 对话框）支持 ↑/↓/Enter/Esc。
- 颜色之外再有形状/文字区分状态（错误加图标与文字）。


---

# dsh 结构（v2，权威）

v1 的界面被用户否决：「完全是 agegr/pi-web 的风格」。v2 必须照搬 **DeepSeek Harness web + dsh-claude-style** 的结构与交互。
以下截图是在本机实际运行 `dsh web`（装了 dsh-claude-style 插件）得到的，是**唯一的视觉与交互依据**，动手前逐张看：

`<shots>` = `/tmp/claude-1000/-home-elio-workbench-pr-pi-web/c33202a9-3bab-46eb-9aae-8a66d05a896d/scratchpad/dshshots`

| 截图 | 内容 |
|---|---|
| `03.png` | 首页：问候语 + 用量统计卡（概览/模型、全部/30天/7天、6 个指标、热力格）+ 底部 composer（上方「工作区」「模式」chip） |
| `07.png` | 对话页：顶栏（标题 · 模式标签 | 居中「对话/轨迹」分段 | 右侧 ↗打开方式、···、右侧栏开关）；一轮回答上方折叠行「已完成，用时 2秒 ⌄」+ 分隔线 |
| `10-fold-open.png` | 外层折叠展开：出现第二层「›_ 执行 3 次思考，调用 6 次工具」 |
| `29-tool-expanded.png` | 第二层展开：步骤列表，每行「图标 动词 · 目标」（读取 · README.md / 查找文件 · demo / 运行命令 · git status / 思考 · …）；点击某步展开输出卡（终端卡：绿点 + cwd 名 + 命令 + 复制，输出等宽）；卡下「‹/› 查看」 |
| `11-trajectory.png` | 轨迹视图：顶部「时长 / 轮次 / 调用」过滤 + 搜索；时间线条（输入/模型/工具三行色条）；下方每条记录一行：角色徽章（系统/用户/上下文/助手/工具）+ 内容；工具行「name {args} → 结果」 |
| `19-multi-turn.png`、`21-turnnav-preview.png` | 对话导航：对话列右侧边缘每轮一条短横线，当前轮更长更深；悬停弹出卡片列出每轮用户提问（当前高亮），点击跳转 |
| `14-rightpanel.png` | 右侧栏打开：对话列变窄；右侧圆角卡片面板，顶部标签栏 + 右上角「分栏 / 全屏 / 收起」（dsh 原有「开始」页，pi-web v3 按用户要求去掉，改为顶栏固定「文件」「Git」） |
| `15-files.png` | 文件标签：路径栏（长路径左侧省略，末段加粗）+ 刷新 + 打开方式；树：文件夹/文件图标 + 名称 |
| `17-file-open.png` | 文件预览标签：标签带文件类型图标；路径栏 + 「代码」视图切换 + 换行 + 刷新；代码卡带语言名、行号、复制 |
| `18-newtab.png` | dsh：「+」新标签 = 开始页；pi-web：「+」= 文件 / Git 菜单 |
| `22-account-menu.png` | 侧栏底部账号行（头像·名字·⌄）→ 菜单：设置 / 反馈 / 登录 |
| `23-settings.png` | 设置模态（大圆角白卡，左导航 + 右内容，右上「打开配置文件」+ ×）：通用设置行 = 左标题+灰色说明，右控件（下拉/开关/三选卡片） |
| `24-settings-models.png` | 设置 › 模型：提供商卡片（名称 + 状态点 + 编辑/删除）+ 虚线「添加模型提供商」 |
| `26-plugins-page.png` | 侧栏「插件」→ 主区插件页：标题 + 说明 + 右上刷新、「+ 添加插件」主按钮；分组（内置插件配置 / 实验性插件 / 已安装插件），每行 44px 图标 + 名称 + 说明 + 右侧开关 |
| `27-more-menu.png` | 顶栏 ··· 菜单 |
| `30-plus-menu.png` | composer 左下「+」菜单：分组「添加」（文件…）与「指令」（压缩/模型/下载日志…），每行图标 + 中文名 + 英文命令名 + 右侧说明 |

细节数值可读 `<refs>/dsh-claude-style/packages/client/src/features/` 下的 `chat-fold/`、`process-column/`、`turn-nav/`、`view-tabs/`、`header-band/`、`sidebar-entries/`、`settings/`、`home/`、`composer/`、`chat-files/` 与 `theme/*.css`（只借数值，不照搬选择器）。

## v2 布局

```
┌ sidebar 280 (可拖宽) ┬─ main ──────────────────────────────┬─ dock (可拖宽, 默认 560) ─┐
│ π pi          [⊟]    │ 标题 · 模型  [对话|轨迹]  [↗][···][◫]│ [文件][Git][a.ts ×][+]  ⛶◫│
│ [🔍 搜索      ]       │                                     │ …/workspace/src/a.ts  ⟳   │
│ ⊕ 新会话             │        user bubble ▸                 │                           │
│ ⌖ 插件               │ 已完成，用时 2秒 ⌄                   │   1 export const a = 1;   │
│ 工作区     [⚙][+]     │ ─────────────────────               │                           │
│ ▾ demo        [+][…] │  ›_ 执行 3 次思考，调用 6 次工具     │                           │
│   ∘ 会话 A  2分钟     │  正文 Markdown…                      │                         ─ │ ← 对话导航贴在 main 右边缘
│   ∘ 会话 B  1小时     │  ⧉ 👍 👎  用量 4.1K tok  06:28      │                         ─ │
│                       │ ┌ composer ──────────────────────┐ │                           │
│ ⋯ pi            ⌄    │ └────────────────────────────────┘ │                           │
│                       │  [+]            模型 档位   ◔ 0%   │                           │
└───────────────────────┴─────────────────────────────────────┴───────────────────────────┘
```

- 右侧栏：白色圆角卡片（`--radius-xl`，`--border-1`，四周 8px 外边距，背景 `--canvas`），与 main 之间一条可拖动分隔（`ui/splitter.tsx`，6px 热区，hover 显示竖线，拖动中为强调色；双击复位 560）。**没有「开始」页**（v3 用户要求）：每个工作区的标签默认就是顶栏的「文件」「Git」，「+」菜单可重新打开被关掉的这两个；关掉最后一个标签即收起右侧栏，下次打开回到默认两个标签。
- 左侧栏同样可拖宽（200 … min(480, 40% 窗宽)，默认 280，存 `pi-web-sidebar-width`，双击复位）；工作区分组可折叠（文件夹图标 hover 变箭头，折叠后显示会话数），点「工作区」标题可折叠整个列表，折叠状态存 `pi-web-sidebar-folded`。
- 输入框：首页与会话页同宽（`--content-width` 744，列 + 左右 24px 内边距）。
- **设置 › 动效**（`settings/motion.tsx`，照 dsh-claude-style 的 Motion 页；偏好在 `app/prefs.ts`，带预览卡）：
  - 动画效果 随系统/减弱/总是 → `<html data-motion>`；`reduced` 时 `styles/base.css` 的总闸把所有动画/过渡压到 0.01ms，脚本侧读 `motionReduced()`。
  - 聊天区滚动动画（`chatFollow`）：跟随到底时每帧补 22% 差距的滑动代替跳变；读者滚轮上滚/触摸/按键即停；「回到底部」按钮居中到输入框上方。
  - 状态行动画（`statusLine`，`transcript/status-line.tsx`）：运行中折叠头 = 三点 loader + 文案换场（上移模糊离场、下方升入，150ms/间隔 50ms）+ 计时；配色「扫光 / 渐变流动」→ `<html data-status-paint>`；精确状态行（`statusDetail`）用 `statusWords()`：「正在读取 README.md」，关闭时只有 正在思考/正在写回答/正在调用工具。
  - 光标动画（`caretMotion`，`composer/caret.ts`）：原生光标透明，绘制 2px 强调色竖条，经镜像 div 测量位置后 80ms 滑动，移动时重置闪烁；输入法组合期间、选区非折叠或失焦时交还原生光标。
  - 新文字淡入（`chatReveal`，`transcript/reveal.ts`）：CSS Custom Highlight API，`[data-reveal]`（运行中的答案）新增字符按年龄分 12 档透明度，120ms 内到实色，批内 2.4ms 错开；不包 DOM，React 照常渲染；不支持该 API 时直接出现。
  - 消息气泡动画（`messageEnter` + `messageEnterStyle`，`transcript/entrance.ts`）：输入框发送前记一笔，随后挂载的用户气泡消费它：原地长出（右下角 scale 0→1，320ms 回弹）或从输入框飞上来（400ms）。打开历史会话不会触发。窄屏（< 1024px）右侧栏覆盖在 main 上（带遮罩），< 768px 全屏。
- 对话列宽 `--content-width` + 48px（与首页一致）；容器 < 880px 时正文右侧让出 48px 给对话导航；右侧栏打开时对话列自适应收窄（截图 14）。
- 偏好（`web/src/app/prefs.ts`）：字号作用于 `--content-font-size`（会话正文）；步骤展示「详细/简洁」；收起时机「回答结束后/始终/从不」；繁忙时发送「排队/插话」。

## v2 折叠规则（核心）

一轮 = 一条 user 消息 + 之后到下一条 user 消息之间的所有条目。
- **答案**：该轮最后一条 assistant 消息里、最后一个 toolCall 之后的 text 块（通常是 stopReason=stop 的那条）。
- **过程**：答案之前的一切——所有 thinking、toolCall（含结果）、中间的 text（作为「说明」步骤）、bashExecution、custom。
- 外层折叠行：完成后「已完成，用时 N秒」（N = 该轮最后时间戳 − user 时间戳，≥60 秒显示「N分M秒」）；运行中「正在思考…」/「正在运行 <动词> · <目标>」带扫光；出错「出错了」；中断「已中断，用时 N秒」。行下一条 `--divider` 细线横贯内容宽度。
- 外层展开后：第二层「›_ 执行 X 次思考，调用 Y 次工具」（X、Y 为 0 时省略对应短语；只有说明步骤时显示「N 个步骤」），再展开才是步骤列表。
- 步骤行：14px 图标 + 动词（`--ink-2`）+ ` · ` + 目标（`--ink-3`，路径可点 → 右侧栏打开文件），hover 背景 `--hover-wash`；点击展开该步详情卡（与 v1 工具卡内容相同：bash 终端卡、edit diff、read 内容…）。
- 「收起时机=回答结束后」：运行中外层与第二层自动展开、步骤逐条出现；答案开始流出或该轮结束后自动收起（用户手动展开过的不再自动收起）。
- 没有任何过程的轮（纯文本回答）不显示折叠行。
