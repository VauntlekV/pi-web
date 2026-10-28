/**
 * Demo data for `demo-transcript.html`: one transcript that hits every render
 * branch (images, thinking, markdown, every tool card, errors, summaries,
 * custom messages, `!` runs) plus a live streaming turn.
 */
import type {
  AgentMessage,
  AssistantMessage,
  ImageContent,
  ToolCallContent,
  ToolResultMessage,
  TranscriptItem,
  Usage,
  UserMessage,
} from "../../../shared/protocol.ts";
import type { ToolRuntime } from "./index.tsx";

const BASE = Date.now() - 8 * 60_000;
const ts = (seconds: number) => BASE + seconds * 1000;

const usage = (totalTokens: number): Usage => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const item = (entryId: string, message: AgentMessage): TranscriptItem => ({ entryId, message });

const text = (value: string) => ({ type: "text" as const, text: value });
const call = (id: string, name: string, args: Record<string, unknown>): ToolCallContent => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const user = (value: string, timestamp: number, images: ImageContent[] = []): UserMessage => ({
  role: "user",
  content: images.length > 0 ? [text(value), ...images] : value,
  timestamp,
});

function assistant(
  content: AssistantMessage["content"],
  timestamp: number,
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    provider: "demo",
    model: "claude-sonnet-4",
    usage: usage(1200),
    stopReason: "stop",
    timestamp,
    ...extra,
  };
}

const result = (
  toolCallId: string,
  toolName: string,
  content: ToolResultMessage["content"],
  timestamp: number,
  extra: Partial<ToolResultMessage> = {},
): ToolResultMessage => ({
  role: "toolResult",
  toolCallId,
  toolName,
  content,
  isError: false,
  timestamp,
  ...extra,
});

const SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200">',
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
  '<stop offset="0" stop-color="#d97757"/><stop offset="1" stop-color="#943333"/>',
  "</linearGradient></defs>",
  '<rect width="320" height="200" fill="url(#g)"/>',
  '<text x="20" y="110" font-family="Georgia, serif" font-size="48" fill="#fff">pi</text>',
  "</svg>",
].join("");

const IMAGE: ImageContent = {
  type: "image",
  mimeType: "image/svg+xml",
  data: btoa(SVG),
};

const READ_OUTPUT = Array.from(
  { length: 45 },
  (_, index) => `export const value${index + 1} = ${index + 1};`,
).join("\n");

const EDIT_DIFF = [
  " 8 const express = require('express');",
  " 9",
  "-10 const PORT = 3000;",
  "+10 const PORT = 30142;",
  " 11 const app = express();",
  " 12",
  "-13 app.listen(PORT);",
  "+13 app.listen(PORT, () => {",
  "+14   console.log(`listening on ${PORT}`);",
  "+15 });",
].join("\n");

const WRITE_CONTENT = [
  "export interface Turn {",
  "  key: string;",
  "  user: UserMessage | null;",
  "  items: TranscriptItem[];",
  "}",
  "",
  "export function groupTurns(items: TranscriptItem[]): Turn[] {",
  "  // …",
  "  return [];",
  "}",
].join("\n");

const LONG_MARKDOWN = [
  "## 文本与链接",
  "",
  "正文里可以混排 **粗体**、*斜体*、~~删除线~~ 和 `行内代码`，也可以放一个[链接](https://example.com/docs)。",
  "",
  "## 列表与任务",
  "",
  "1. 先读配置",
  "2. 再渲染界面",
  "   - 亮色与暗色各一套",
  "",
  "- [x] 接入配色令牌",
  "- [ ] 补全文档",
  "",
  "## 表格",
  "",
  "| 格式 | 写法 | 用途 |",
  "| --- | --- | --- |",
  "| 粗体 | `**文字**` | 强调重点 |",
  "| 代码 | `` `code` `` | 标出标识符 |",
  "| 引用 | `> 文字` | 摘录原文 |",
  "| 长内容 | lorem ipsum | 一段较长的说明文字 |",
  "| 命令 | `find . -type f -name '*.ts' -not -path './node_modules/*' -exec wc -l {} +` | 统计源码行数 |",
  "",
  "## 代码块",
  "",
  "```ts",
  "export function greet(name: string): string {",
  "  return `Hello, ${name}!`;",
  "}",
  "```",
  "",
  "```bash",
  "$ npx vitest run web/src/transcript",
  "Test Files  1 passed (1)",
  "     Tests  36 passed (36)",
  "```",
  "",
  "> 排版清楚的回答，读起来更轻松。",
  "",
  "### 细节",
  "",
  "全角字符 ＡＢＣ、中文标点，以及 emoji 😀 都应正常显示。",
].join("\n");

const COMPACTION_SUMMARY = [
  "之前的工作：搭建 transcript 目录、确定 Turn 分组规则，并跑通了第一批单元测试。",
  "",
  "遗留问题：",
  "",
  "- 工具卡片还需要支持流式输出",
  "- 暗色主题的代码高亮还没校准",
].join("\n");

const CUSTOM_CONTENT = [
  "扩展注入的提示：**本轮已启用实验性渲染器**。",
  "",
  "- 卡片样式与工具卡片一致",
  "- 内容按 Markdown 渲染",
].join("\n");

const BRANCH_SUMMARY = "从“UI 骨架”分支回到主线的摘要：保留 tool card 结构，丢弃旧的占位渲染。";

export const fixtureItems: TranscriptItem[] = [
  item(
    "e1",
    {
      role: "compactionSummary",
      summary: COMPACTION_SUMMARY,
      tokensBefore: 12_345,
      timestamp: ts(0),
    },
  ),
  item("e2", user("帮我检查一下这个项目的 Markdown 渲染，然后再看下 README。", ts(10), [IMAGE])),

  item(
    "e3",
    assistant(
      [
        { type: "thinking", thinking: "先看目录结构，确认用的是 Vite 还是别的构建器。\n然后再决定从哪里开始改。" },
        text("我先看一下目录结构，再读一遍 README。"),
        call("t1", "bash", { command: "ls -la\nfind . -name '*.ts' | head -20" }),
        call("t2", "read", { path: "/home/pi/demo-project/src/app.ts", offset: 10, limit: 50 }),
      ],
      ts(14),
      { stopReason: "toolUse", usage: usage(2100) },
    ),
  ),
  item(
    "e4",
    result(
      "t1",
      "bash",
      [
        text(
          "\u001b[1mtotal 32\u001b[0m\nREADME.md\npackage.json\nsrc\n\u001b[32m✓\u001b[0m 42 files, 3 dirs",
        ),
      ],
      ts(15),
    ),
  ),
  item("e5", result("t2", "read", [text(READ_OUTPUT)], ts(16))),

  item(
    "e6",
    assistant(
      [
        text("目录没问题。我把端口换成 30142，顺手补一个启动日志。"),
        call("t3", "edit", {
          path: "/home/pi/demo-project/src/server.ts",
          edits: [{ oldText: "const PORT = 3000;", newText: "const PORT = 30142;" }],
        }),
        call("t4", "write", { path: "/home/pi/demo-project/src/transcript/lib.ts", content: WRITE_CONTENT }),
        call("t5", "mcp__github__search", { query: "transcript renderer", limit: 5 }),
        call("t8", "read", { path: "/home/pi/demo-project/assets/logo.svg" }),
      ],
      ts(20),
      { stopReason: "toolUse", usage: usage(900) },
    ),
  ),
  item(
    "e7",
    result("t3", "edit", [], ts(21), {
      details: { diff: EDIT_DIFF, patch: "" },
    }),
  ),
  item("e8", result("t4", "write", [text("写入 10 行：/home/pi/demo-project/src/transcript/lib.ts")], ts(22))),
  item(
    "e9",
    result("t5", "mcp__github__search", [text("Error: MCP server \"github\" is not connected.")], ts(23), {
      isError: true,
    }),
  ),
  item("e9b", result("t8", "read", [IMAGE], ts(24))),

  item("e10", assistant([text(LONG_MARKDOWN)], ts(40), { usage: usage(4400) })),

  item("e11", user("再跑一下测试，看看有没有挂掉的。", ts(120))),
  item("e12", assistant([call("t6", "bash", { command: "npx vitest run" })], ts(121), { stopReason: "toolUse" })),
  item(
    "e13",
    result(
      "t6",
      "bash",
      [text("FAIL web/src/transcript/lib.test.ts\n  ✗ groups turns by user message\n    expected 2, received 1")],
      ts(126),
      { isError: true },
    ),
  ),
  item(
    "e14",
    assistant([text("测试失败了：`groupTurns` 在连续两条用户消息时只留下一轮，我接下来修这个断言。")], ts(130), {
      usage: usage(1800),
    }),
  ),

  item("e15", user("先别改了，我看看还有多少额度。", ts(200))),
  item(
    "e16",
    assistant(
      [{ type: "thinking", thinking: "", redacted: true }, text("我查一下——")],
      ts(201),
      {
        stopReason: "error",
        errorMessage: "429 rate limit exceeded: retry after 30s",
      },
    ),
  ),

  item("e17", user("那就换一个思路。", ts(260))),
  item("e18", assistant([text("我先")], ts(261), { stopReason: "aborted" })),

  item("e19", user("顺便看下 git 记录。", ts(320))),
  item(
    "e20",
    {
      role: "bashExecution",
      command: "git log --oneline -5",
      output: "a1b2c3d transcript: tool cards\n9f8e7d6 transcript: markdown\n5c4b3a2 styles: tokens",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: ts(321),
    },
  ),
  item("e21", assistant([text("最近三次提交都在 transcript 目录，结构清晰。")], ts(325), { usage: usage(700) })),
  item(
    "e21b",
    {
      role: "bashExecution",
      command: "npm run dev",
      output: "^C",
      exitCode: undefined,
      cancelled: true,
      truncated: false,
      timestamp: ts(330),
    },
  ),

  item("e22", user("输出一个扩展卡片给我看看。", ts(380))),
  item(
    "e23",
    {
      role: "custom",
      customType: "demo.note",
      content: CUSTOM_CONTENT,
      display: true,
      timestamp: ts(381),
    },
  ),
  item(
    "e23b",
    {
      role: "custom",
      customType: "demo.hidden",
      content: "display: false 的消息不应渲染。",
      display: false,
      timestamp: ts(381.5),
    },
  ),
  item(
    "e24",
    {
      role: "branchSummary",
      summary: BRANCH_SUMMARY,
      fromId: "e20",
      timestamp: ts(382),
    },
  ),

  item("e25", user("总结一下刚才的改动。", ts(440))),
];

const STREAMING: AssistantMessage = {
  role: "assistant",
  content: [
    text("我再确认一下测试的失败原因。"),
    call("t7", "grep", { pattern: "groupTurns", path: "/home/pi/demo-project/src" }),
    {
      type: "thinking",
      thinking: "先定位失败的断言，再从 groupTurns 的实现里找连续用户消息的分支……",
    },
  ],
  provider: "demo",
  model: "claude-sonnet-4",
  usage: usage(320),
  stopReason: "pending",
  timestamp: ts(445),
};

export const fixtureTools: Record<string, ToolRuntime> = {
  t1: { status: "done", durationMs: 1234 },
  t2: { status: "done", durationMs: 45 },
  t3: { status: "done", durationMs: 320 },
  t4: { status: "done" },
  t5: { status: "error", durationMs: 2100 },
  t6: { status: "error", durationMs: 4300 },
  t8: { status: "done", durationMs: 25 },
  t7: {
    status: "running",
    partial: { content: [text("src/transcript/lib.test.ts:42: expect(turns).toHaveLength(2)\n")] },
  },
};

export const fixtureStreaming: AssistantMessage = STREAMING;
export const fixtureCwd = "/home/pi/demo-project";
