import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  TranscriptItem,
  UserMessage,
} from "../../../shared/protocol.ts";
import { buildBands, buildRows, compactArgs, filterRows, MAX_DETAIL } from "./rows.ts";

const TS = 1_700_000_000_000;

const usage = (totalTokens = 100): AssistantMessage["usage"] => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const text = (value: string): TextContent => ({ type: "text", text: value });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallContent => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

const user = (value: string, timestamp = TS): UserMessage => ({ role: "user", content: value, timestamp });

function assistant(
  content: AssistantMessage["content"],
  extra: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content,
    provider: "test",
    model: "test",
    usage: usage(),
    stopReason: "stop",
    timestamp: TS + 1000,
    ...extra,
  };
}

function result(toolCallId: string, output?: string, extra: Partial<ToolResultMessage> = {}): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: output === undefined ? [] : [text(output)],
    isError: false,
    timestamp: TS + 900,
    ...extra,
  };
}

const item = (entryId: string, message: AgentMessage): TranscriptItem => ({ entryId, message });

describe("buildRows", () => {
  it("keeps one row per role and numbers the turns", () => {
    const rows = buildRows(
      [
        item("u1", user("第一轮提问")),
        item(
          "a1",
          assistant([
            { type: "thinking", thinking: "先想一想\n第二行" },
            text("说明一句"),
            call("t1", "bash", { command: "ls" }),
          ]),
        ),
        item("r1", result("t1", "README.md")),
        item("u2", user("第二轮提问")),
        item("a2", assistant([text("第二轮回答")])),
      ],
      null,
    );

    expect(rows.map((row) => row.role)).toEqual(["user", "thinking", "assistant", "tool", "user", "assistant"]);
    expect(rows.map((row) => row.turn)).toEqual([0, 0, 0, 0, 1, 1]);
    expect(rows.map((row) => row.badge)).toEqual(["用户", "思考", "助手", "工具", "用户", "助手"]);
    expect(rows[0]!.kind).toBe("message");
    expect(rows[3]!.kind).toBe("tool");
    expect(rows[1]!.text).toBe("先想一想");
  });

  it("pairs a tool call with its result", () => {
    const rows = buildRows(
      [item("u1", user("go")), item("a1", assistant([call("t1", "read", { path: "README.md" })])) , item("r1", result("t1", "line one\nline two"))],
      null,
    );
    const tool = rows.find((row) => row.kind === "tool")!;
    expect(tool.tool).toEqual({ name: "read", args: '{"path":"README.md"}', result: "line one" });
    expect(tool.text).toBe('read {"path":"README.md"} → line one');
    expect(tool.detail).toContain("line one\nline two");
  });

  it("keeps a tool row when the result is missing or failed", () => {
    const rows = buildRows(
      [
        item("u1", user("go")),
        item("a1", assistant([call("t1", "bash", { command: "false" })])),
        item("r1", result("t1", "boom", { isError: true })),
        item("a2", assistant([call("t2", "bash", { command: "sleep 10" })])),
      ],
      null,
    );
    const tools = rows.filter((row) => row.kind === "tool");
    expect(tools).toHaveLength(2);
    expect(tools[0]!.isError).toBe(true);
    expect(tools[1]!.tool?.result).toBe("");
    expect(tools[1]!.text).toBe('bash {"command":"sleep 10"}');
  });

  it("appends the streaming message to the current turn", () => {
    const live = assistant([text("正在输出")], { stopReason: "pending", timestamp: TS + 5000 });
    const rows = buildRows([item("u1", user("go")), item("a1", assistant([text("先说一句")]))], live);
    expect(rows.map((row) => row.text)).toEqual(["go", "先说一句", "正在输出"]);
    expect(rows.at(-1)!.turn).toBe(0);
    expect(buildRows([], live).map((row) => row.turn)).toEqual([0]);
  });

  it("adds command, custom and summary rows", () => {
    const bash: BashExecutionMessage = {
      role: "bashExecution",
      command: "git status",
      output: "clean",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: TS + 100,
    };
    const rows = buildRows(
      [
        item("s1", { role: "compactionSummary", summary: "早先的工作", tokensBefore: 1200, timestamp: TS - 10 }),
        item("u1", user("go")),
        item("b1", bash),
        item("c1", { role: "custom", customType: "demo.note", content: "扩展提示", display: true, timestamp: TS + 200 }),
        item("c2", { role: "custom", customType: "demo.hidden", content: "不显示", display: false, timestamp: TS + 300 }),
        item("br", { role: "branchSummary", summary: "分支摘要正文", fromId: null, timestamp: TS + 400 }),
      ],
      null,
    );
    expect(rows.map((row) => row.role)).toEqual(["summary", "user", "command", "summary", "summary"]);
    expect(rows[0]!.text).toBe("已压缩上下文 · 压缩前 1200 tok");
    expect(rows[0]!.detail).toBe("早先的工作");
    expect(rows[2]!.detail).toBe("$ git status\n\nclean");
    expect(rows[3]!.text).toBe("demo.note 扩展提示");
    expect(rows[4]!.text).toBe("分支摘要");
  });

  it("caps the detail body", () => {
    const long = "x".repeat(MAX_DETAIL + 50);
    const rows = buildRows([item("u1", user(long))], null);
    expect(rows[0]!.detail).toHaveLength(MAX_DETAIL);
  });
});

describe("filterRows", () => {
  const rows = buildRows(
    [
      item("u1", user("看看 README")),
      item("a1", assistant([call("t1", "bash", { command: "ls -la" })])),
      item("r1", result("t1", "README.md")),
    ],
    null,
  );

  it("filters by segment", () => {
    expect(filterRows(rows, "all", "").map((row) => row.role)).toEqual(["user", "tool"]);
    expect(filterRows(rows, "message", "").map((row) => row.role)).toEqual(["user"]);
    expect(filterRows(rows, "tool", "").map((row) => row.role)).toEqual(["tool"]);
  });

  it("searches row text, case-insensitively", () => {
    expect(filterRows(rows, "all", "readme").map((row) => row.role)).toEqual(["user", "tool"]);
    expect(filterRows(rows, "all", "  LS -LA ").map((row) => row.role)).toEqual(["tool"]);
    expect(filterRows(rows, "all", "nope")).toEqual([]);
    expect(filterRows(rows, "message", "ls")).toEqual([]);
  });
});

describe("buildBands", () => {
  it("lays the records on their lanes with proportional widths", () => {
    const rows = buildRows(
      [
        item("u1", user("go", TS)),
        item("a1", assistant([call("t1", "bash", { command: "ls" })], { timestamp: TS + 500 })),
        item("r1", result("t1", "ok", { timestamp: TS + 600 })),
        item("a2", assistant([text("done")], { timestamp: TS + 1000 })),
      ],
      null,
    );
    const bands = buildBands(rows);
    expect(bands.map((band) => band.lane)).toEqual([0, 2, 1]);
    expect(bands[0]).toMatchObject({ left: 0, width: 50 });
    expect(bands[1]).toMatchObject({ left: 50, width: 50 });
    expect(bands[2]!.left).toBe(100 - bands[2]!.width);
    expect(bands.every((band) => band.width > 0)).toBe(true);
  });

  it("survives a single record and an empty list", () => {
    expect(buildBands([])).toEqual([]);
    const bands = buildBands(buildRows([item("u1", user("only"))], null));
    expect(bands).toEqual([{ id: "u1", lane: 0, left: 0, width: 100 }]);
  });
});

describe("compactArgs", () => {
  it("keeps the JSON on one line and cuts long arguments", () => {
    expect(compactArgs({ path: "a.ts", n: 1 })).toBe('{"path":"a.ts","n":1}');
    expect(compactArgs(undefined)).toBe("{}");
    expect(compactArgs({ text: "x".repeat(500) }).endsWith("…")).toBe(true);
    expect(compactArgs({ text: "x".repeat(500) }).length).toBeLessThanOrEqual(201);
  });
});
