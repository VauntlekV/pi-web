import { describe, expect, it } from "vitest";
import type {
  AgentMessage,
  AssistantMessage,
  BashExecutionMessage,
  CustomMessage,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  TranscriptItem,
  UserMessage,
} from "../../../shared/protocol.ts";
import { groupTurns } from "./lib.ts";
import { dockPath, foldHeadText, foldSummary, formatDuration, runningLabel, splitTurn, stepOf } from "./turns.ts";

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
const thinking = (value: string): AssistantMessage["content"][number] => ({ type: "thinking", thinking: value });
const call = (id: string, name: string, args: Record<string, unknown> = {}): ToolCallContent => ({
  type: "toolCall",
  id,
  name,
  arguments: args,
});

function user(value: string, timestamp = TS): UserMessage {
  return { role: "user", content: value, timestamp };
}

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
    timestamp: TS + 2000,
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
    timestamp: TS + 1500,
    ...extra,
  };
}

const item = (entryId: string, message: AgentMessage): TranscriptItem => ({ entryId, message });

/** The single turn of a one-turn transcript. */
function turnOf(messages: AgentMessage[]) {
  const turns = groupTurns(
    messages.map((message, index) => item(`e${index}`, message)),
    null,
  );
  return turns[0]!;
}

describe("splitTurn", () => {
  it("leaves a plain text answer without steps", () => {
    const turn = turnOf([user("hi"), assistant([text("你好，有什么可以帮你？")])]);
    const split = splitTurn(turn);
    expect(split.steps).toEqual([]);
    expect(split.answer).toEqual([text("你好，有什么可以帮你？")]);
    expect(split.thinkingCount).toBe(0);
    expect(split.toolCount).toBe(0);
    expect(split.status).toBe("done");
    expect(split.durationMs).toBe(2000);
  });

  it("keeps tools and earlier text as steps and the trailing text as the answer", () => {
    const turn = turnOf([
      user("go"),
      assistant([
        thinking("先看目录"),
        text("我先看一下目录。"),
        call("t1", "bash", { command: "ls -la" }),
        call("t2", "read", { path: "/p/src/a.ts", offset: 10, limit: 51 }),
      ]),
      result("t1", "README.md"),
      result("t2", "export {}"),
      assistant([text("目录没问题，"), text("端口是 30142。")]),
    ]);
    const split = splitTurn(turn, { cwd: "/p" });
    expect(split.steps.map((step) => step.verb)).toEqual(["思考", "说明", "运行命令", "读取"]);
    expect(split.steps[3]!.target).toBe("src/a.ts L10-60");
    expect(split.steps[3]!.path).toBe("src/a.ts");
    expect(split.steps[2]!.status).toBe("done");
    expect(split.answer).toEqual([text("目录没问题，"), text("端口是 30142。")]);
    expect(split.thinkingCount).toBe(1);
    expect(split.toolCount).toBe(2);
  });

  it("takes only the text after the last tool call of the last message", () => {
    const turn = turnOf([
      user("go"),
      assistant([
        text("第一段说明"),
        call("t1", "bash", { command: "ls" }),
        text("第二段说明"),
        call("t2", "grep", { pattern: "todo" }),
        text("这才是答案"),
      ]),
    ]);
    const split = splitTurn(turn);
    expect(split.answer).toEqual([text("这才是答案")]);
    expect(split.steps.map((step) => step.kind)).toEqual(["text", "tool", "text", "tool"]);
  });

  it("has no answer while the last assistant only calls a tool", () => {
    const turn = turnOf([user("go"), assistant([call("t1", "bash", { command: "npm test" })], { stopReason: "toolUse" })]);
    const split = splitTurn(turn, { live: true });
    expect(split.answer).toBeNull();
    expect(split.steps).toHaveLength(1);
    expect(split.steps[0]!.status).toBe("running");
    expect(split.status).toBe("running");
  });

  it("marks the turn running only when it is the live one", () => {
    const turn = turnOf([user("go"), assistant([call("t1", "bash", { command: "ls" })], { stopReason: "toolUse" })]);
    expect(splitTurn(turn, { live: true }).status).toBe("running");
    expect(splitTurn(turn).status).toBe("done");
    expect(splitTurn(turn).steps[0]!.status).toBe("none");
  });

  it("reports error and aborted turns", () => {
    const failed = splitTurn(
      turnOf([user("go"), assistant([text("试着回答")], { stopReason: "error", errorMessage: "429" })]),
    );
    expect(failed.status).toBe("error");
    const aborted = splitTurn(turnOf([user("go"), assistant([text("我先")], { stopReason: "aborted" })]));
    expect(aborted.status).toBe("aborted");
    expect(aborted.answer).toEqual([text("我先")]);
  });

  it("reads status from tool runtimes when present", () => {
    const turn = turnOf([user("go"), assistant([call("t1", "bash", { command: "ls" })])]);
    const runtime = { t1: { status: "running" as const, durationMs: 10 } };
    expect(splitTurn(turn, { tools: runtime }).steps[0]!.status).toBe("running");
    expect(splitTurn(turn, { tools: { t1: { status: "error" } } }).steps[0]!.status).toBe("error");
  });

  it("tolerates a missing tool result", () => {
    const turn = turnOf([user("go"), assistant([call("t1", "read", { path: "/p/a.ts" })])]);
    const split = splitTurn(turn, { cwd: "/p" });
    expect(split.steps[0]!.result).toBeUndefined();
    expect(split.steps[0]!.status).toBe("none");
  });

  it("takes the streaming message from the turn or from the options", () => {
    const live = assistant([text("部分答案")], { stopReason: "pending", timestamp: TS + 5000 });
    const settled = turnOf([user("go"), assistant([text("先说一句"), call("t1", "bash", { command: "ls" })])]);
    settled.streaming = live;
    const fromTurn = splitTurn(settled, { live: true });
    expect(fromTurn.status).toBe("running");
    expect(fromTurn.answer).toEqual([text("部分答案")]);
    expect(fromTurn.answer).not.toContainEqual(text("先说一句"));
    expect(fromTurn.steps.map((step) => step.kind)).toEqual(["text", "tool"]);
    expect(fromTurn.durationMs).toBe(5000);

    const withoutStreaming = turnOf([user("go"), assistant([call("t1", "bash", { command: "ls" })])]);
    const fromOptions = splitTurn(withoutStreaming, { live: true, streaming: live });
    expect(fromOptions.answer).toEqual([text("部分答案")]);
    expect(fromOptions.status).toBe("running");
  });

  it("keeps a thinking block last while streaming", () => {
    const live = assistant([text("先说一句"), thinking("再想想")], { stopReason: "pending" });
    const split = splitTurn(turnOf([user("go")]), { live: true, streaming: live });
    // No tool call in that message, so all of its text is the answer already.
    expect(split.steps.map((step) => step.kind)).toEqual(["thinking"]);
    expect(split.answer).toEqual([text("先说一句")]);
    expect(runningLabel(split.steps)).toBe("正在思考…");
  });

  it("keeps the tool call in flight while the last block is a tool call", () => {
    const live = assistant([text("先看目录"), call("t1", "bash", { command: "ls" })], { stopReason: "pending" });
    const split = splitTurn(turnOf([user("go")]), { live: true, streaming: live });
    expect(split.answer).toBeNull();
    expect(split.steps.map((step) => step.kind)).toEqual(["text", "tool"]);
    expect(split.steps[1]!.status).toBe("running");
    expect(runningLabel(split.steps)).toBe("正在运行命令 · ls");
  });

  it("drops thinking steps in compact mode", () => {
    const turn = turnOf([
      user("go"),
      assistant([thinking("想一想"), call("t1", "bash", { command: "ls" })]),
    ]);
    const detailed = splitTurn(turn);
    expect(detailed.thinkingCount).toBe(1);
    const compact = splitTurn(turn, { thinking: false });
    expect(compact.steps.map((step) => step.kind)).toEqual(["tool"]);
    expect(compact.thinkingCount).toBe(0);
    expect(compact.toolCount).toBe(1);
  });

  it("turns bash executions and custom messages into steps", () => {
    const bash: BashExecutionMessage = {
      role: "bashExecution",
      command: "git status",
      output: "clean",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: TS + 100,
    };
    const shown: CustomMessage = {
      role: "custom",
      customType: "demo.note",
      content: "扩展注入的提示\n第二行",
      display: true,
      timestamp: TS + 200,
    };
    const hidden: CustomMessage = { ...shown, customType: "demo.hidden", display: false };
    const turn = turnOf([user("go"), bash, shown, hidden, assistant([text("好了")])]);
    const split = splitTurn(turn);
    expect(split.steps.map((step) => step.kind)).toEqual(["command", "custom"]);
    expect(split.steps[0]).toMatchObject({ verb: "用户命令", target: "git status", status: "done" });
    expect(split.steps[1]).toMatchObject({ verb: "demo.note", target: "扩展注入的提示" });
    expect(split.answer).toEqual([text("好了")]);
  });

  it("marks a failed user command as an error", () => {
    const bash: BashExecutionMessage = {
      role: "bashExecution",
      command: "false",
      output: "",
      exitCode: 1,
      cancelled: false,
      truncated: false,
      timestamp: TS + 100,
    };
    expect(splitTurn(turnOf([user("go"), bash])).steps[0]!.status).toBe("error");
  });

  it("has no duration without a user message", () => {
    const split = splitTurn(turnOf([assistant([text("continue")])]));
    expect(split.durationMs).toBeNull();
    expect(split.answer).toEqual([text("continue")]);
  });
});

describe("formatDuration", () => {
  it("formats the boundaries", () => {
    expect(formatDuration(0)).toBe("<1秒");
    expect(formatDuration(999)).toBe("<1秒");
    expect(formatDuration(1000)).toBe("1秒");
    expect(formatDuration(59_999)).toBe("59秒");
    expect(formatDuration(60_000)).toBe("1分0秒");
    expect(formatDuration(3_725_000)).toBe("62分5秒");
  });

  it("clamps rubbish to <1秒", () => {
    expect(formatDuration(-1)).toBe("<1秒");
    expect(formatDuration(Number.NaN)).toBe("<1秒");
  });
});

describe("foldSummary", () => {
  it("drops parts that are zero", () => {
    expect(foldSummary(3, 6, 9)).toBe("执行 3 次思考，调用 6 次工具");
    expect(foldSummary(3, 0, 3)).toBe("执行 3 次思考");
    expect(foldSummary(0, 6, 6)).toBe("调用 6 次工具");
    expect(foldSummary(0, 0, 2)).toBe("2 个步骤");
  });
});

describe("foldHeadText", () => {
  const split = (over: Partial<ReturnType<typeof splitTurn>> = {}) =>
    ({ steps: [], answer: null, thinkingCount: 0, toolCount: 0, status: "done", durationMs: 2000, ...over }) as ReturnType<
      typeof splitTurn
    >;

  it("words the finished, failed and aborted states", () => {
    expect(foldHeadText(split(), { live: false })).toBe("已完成，用时 2秒");
    expect(foldHeadText(split({ status: "error" }), { live: false })).toBe("出错了，用时 2秒");
    expect(foldHeadText(split({ status: "aborted", durationMs: 61_000 }), { live: false })).toBe(
      "已中断，用时 1分1秒",
    );
  });

  it("names the step in flight while running", () => {
    expect(foldHeadText(split({ status: "running" }), { live: true })).toBe("正在思考…");
    expect(foldHeadText(split({ status: "running" }), { live: true, workingMessage: "整理文件" })).toBe("整理文件");
  });
});

describe("runningLabel", () => {
  it("uses the last step's verb and target", () => {
    const step = stepOf(call("t1", "bash", { command: "npm test" }));
    expect(runningLabel([{ key: "1", kind: "tool", status: "running", ...step }])).toBe("正在运行命令 · npm test");
    expect(
      runningLabel([{ key: "1", kind: "tool", status: "running", ...stepOf(call("t2", "read", { path: "src/a.ts" })) }]),
    ).toBe("正在读取 · src/a.ts");
  });

  it("falls back to thinking when there is no step", () => {
    expect(runningLabel([])).toBe("正在思考…");
  });
});

describe("stepOf", () => {
  const cwd = "/p";

  it("maps the file tools", () => {
    expect(stepOf(call("1", "read", { path: "/p/src/a.ts", offset: 10, limit: 51 }), cwd)).toEqual({
      icon: "FileText",
      verb: "读取",
      target: "src/a.ts L10-60",
      path: "src/a.ts",
    });
    expect(stepOf(call("1", "edit", { path: "/p/a.ts" }), cwd)).toMatchObject({
      icon: "FilePen",
      verb: "编辑",
      target: "a.ts",
      path: "a.ts",
    });
    expect(stepOf(call("1", "write", { path: "/p/a.ts", content: "x" }), cwd)).toMatchObject({
      icon: "FilePlus",
      verb: "写入",
      target: "a.ts",
      path: "a.ts",
    });
    expect(stepOf(call("1", "ls", { path: "/p/src" }), cwd)).toEqual({
      icon: "FolderOpen",
      verb: "列出",
      target: "src",
      path: "src",
    });
  });

  it("adds the diff stat to an edit", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "-old", "+new", "+again"].join("\n");
    expect(stepOf(call("1", "edit", { path: "/p/a.ts" }), cwd, result("1", "", { details: { diff } }))).toMatchObject({
      target: "a.ts",
      suffix: "+2 −1",
    });
  });

  it("maps the search and shell tools", () => {
    expect(stepOf(call("1", "bash", { command: "npm test\nmore" }))).toEqual({
      icon: "SquareTerminal",
      verb: "运行命令",
      target: "npm test",
    });
    expect(stepOf(call("1", "grep", { pattern: "TODO" }))).toEqual({ icon: "Search", verb: "搜索", target: "TODO" });
    expect(stepOf(call("1", "glob", { pattern: "**/*.ts" }))).toEqual({
      icon: "FolderSearch",
      verb: "查找文件",
      target: "**/*.ts",
    });
    expect(stepOf(call("1", "find", { pattern: "demo" }))).toEqual({
      icon: "FolderSearch",
      verb: "查找文件",
      target: "demo",
    });
  });

  it("maps the question tool", () => {
    expect(
      stepOf(call("1", "ask_user_question", { questions: [{ question: "用哪个端口？", options: [] }] })),
    ).toEqual({ icon: "MessageCircleQuestion", verb: "提问", target: "用哪个端口？" });
  });

  it("falls back to the tool name and first string argument", () => {
    expect(stepOf(call("1", "mcp_thing", { query: "hello", n: 1 }))).toEqual({
      icon: "Wrench",
      verb: "mcp_thing",
      target: "hello",
    });
  });

  it("leaves paths outside cwd unclickable", () => {
    expect(stepOf(call("1", "read", { path: "/elsewhere/a.ts" }), cwd)).toMatchObject({
      target: "/elsewhere/a.ts",
      path: undefined,
    });
    expect(stepOf(call("1", "read", { path: "src/a.ts" }), cwd)).toMatchObject({ path: "src/a.ts" });
  });
});

describe("dockPath", () => {
  it("keeps paths inside cwd relative", () => {
    expect(dockPath("/p/src/a.ts", "/p")).toBe("src/a.ts");
    expect(dockPath("src/a.ts", "/p")).toBe("src/a.ts");
    expect(dockPath("./src/a.ts", "/p")).toBe("src/a.ts");
  });

  it("refuses paths it cannot place inside cwd", () => {
    expect(dockPath("/elsewhere/a.ts", "/p")).toBeNull();
    expect(dockPath("/p/a.ts", undefined)).toBeNull();
    expect(dockPath("~/a.ts", "/p")).toBeNull();
    expect(dockPath("", "/p")).toBeNull();
  });
});
