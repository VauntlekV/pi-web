import { describe, expect, it } from "vitest";
import type {
  AssistantMessage,
  TextContent,
  ToolCallContent,
  ToolResultMessage,
  TranscriptItem,
  UserMessage,
} from "../../../shared/protocol.ts";
import {
  diffStats,
  formatClock,
  formatTokens,
  groupTurns,
  guessLanguage,
  indicatorText,
  limitHighlight,
  relativizePath,
  stripAnsi,
  toolSummary,
  truncate,
  turnText,
  type HastNode,
} from "./lib.ts";

const TS = 1_700_000_000_000;

function usage(totalTokens = 100): AssistantMessage["usage"] {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function user(text: string): UserMessage {
  return { role: "user", content: text, timestamp: TS };
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
    timestamp: TS,
    ...extra,
  };
}

function item(entryId: string | null, message: TranscriptItem["message"]): TranscriptItem {
  return { entryId, message };
}

function text(text: string): TextContent {
  return { type: "text", text };
}

function call(id: string, name: string, args: Record<string, unknown> = {}): ToolCallContent {
  return { type: "toolCall", id, name, arguments: args };
}

function result(toolCallId: string, output?: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "bash",
    content: output === undefined ? [] : [text(output)],
    isError: false,
    timestamp: TS,
  };
}

describe("groupTurns", () => {
  it("returns no turns for an empty transcript", () => {
    expect(groupTurns([], null)).toEqual([]);
  });

  it("returns no turns when items and streaming are both empty", () => {
    expect(groupTurns([], null)).toHaveLength(0);
  });

  it("opens a turn when the transcript starts with an assistant message", () => {
    const message = assistant([text("hi")]);
    const turns = groupTurns([item("a1", message)], null);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user).toBeNull();
    expect(turns[0]!.key).toBe("a1");
    expect(turns[0]!.assistants).toEqual([message]);
    expect(turns[0]!.items).toHaveLength(1);
  });

  it("attaches streaming to the turn opened by the last user message", () => {
    const message = assistant([{ type: "thinking", thinking: "…" }], { stopReason: "pending" });
    const turns = groupTurns([item("u1", user("hello"))], message);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user?.content).toBe("hello");
    expect(turns[0]!.streaming).toBe(message);
    expect(turns[0]!.assistants).toEqual([message]);
  });

  it("creates a turn for a streaming message with no items", () => {
    const message = assistant([text("partial")], { stopReason: "pending" });
    const turns = groupTurns([], message);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.user).toBeNull();
    expect(turns[0]!.streaming).toBe(message);
  });

  it("groups every non-user item into the turn that opened it", () => {
    const turns = groupTurns(
      [
        item("u1", user("first")),
        item("a1", assistant([text("one"), call("t1", "read", { path: "a.ts" })])),
        item("r1", result("t1", "file")),
        item("u2", user("second")),
        item("a2", assistant([text("two")])),
      ],
      null,
    );
    expect(turns).toHaveLength(2);
    expect(turns[0]!.items.map((i) => i.entryId)).toEqual(["a1", "r1"]);
    expect(turns[0]!.toolIds).toEqual(["t1"]);
    expect(turns[0]!.results.t1).toBeDefined();
    expect(turns[1]!.user?.content).toBe("second");
    expect(turns[1]!.assistants).toHaveLength(1);
    expect(turns[1]!.results).toEqual({});
  });

  it("keeps a tool result that arrives before its call", () => {
    const turns = groupTurns(
      [
        item("u1", user("go")),
        item("r1", result("t1", "early")),
        item("a1", assistant([call("t1", "bash", { command: "ls" })])),
      ],
      null,
    );
    expect(turns[0]!.results.t1?.content).toEqual([text("early")]);
    expect(turns[0]!.toolIds).toEqual(["t1"]);
  });

  it("keeps orphan tool results without inventing a call", () => {
    const turns = groupTurns([item("u1", user("go")), item("r1", result("ghost"))], null);
    expect(turns).toHaveLength(1);
    expect(turns[0]!.results.ghost).toBeDefined();
    expect(turns[0]!.toolIds).toEqual([]);
    expect(turns[0]!.assistants).toEqual([]);
  });

  it("gives every turn a distinct key", () => {
    const turns = groupTurns(
      [
        item("u1", user("a")),
        item("u2", user("b")),
        item(null, assistant([text("c")])),
      ],
      null,
    );
    expect(new Set(turns.map((t) => t.key)).size).toBe(turns.length);
  });
});

describe("relativizePath", () => {
  it("strips the cwd prefix", () => {
    expect(relativizePath("/a/b/c.ts", "/a/b")).toBe("c.ts");
    expect(relativizePath("/a/b/src/c.ts", "/a/b")).toBe("src/c.ts");
  });

  it("tolerates a trailing slash on cwd", () => {
    expect(relativizePath("/a/b/c.ts", "/a/b/")).toBe("c.ts");
    expect(relativizePath("/a/b", "/a/b///")).toBe(".");
  });

  it("does not strip a mere string prefix", () => {
    expect(relativizePath("/a/bc/d.ts", "/a/b")).toBe("/a/bc/d.ts");
  });

  it("handles a path that is exactly the cwd", () => {
    expect(relativizePath("/a/b", "/a/b")).toBe(".");
  });

  it("handles cwd '/'", () => {
    expect(relativizePath("/a/b", "/")).toBe("a/b");
    expect(relativizePath("/", "/")).toBe("/");
    expect(relativizePath("a/b", "/")).toBe("a/b");
  });

  it("leaves paths alone without a usable cwd", () => {
    expect(relativizePath("/a/b", undefined)).toBe("/a/b");
    expect(relativizePath("/a/b", "")).toBe("/a/b");
    expect(relativizePath("src/a.ts", "/a/b")).toBe("src/a.ts");
  });
});

describe("stripAnsi", () => {
  it("removes basic colour sequences", () => {
    expect(stripAnsi("\u001b[31mred\u001b[0m")).toBe("red");
    expect(stripAnsi("\u001b[1;32mok\u001b[39m!")).toBe("ok!");
  });

  it("removes 256-colour sequences", () => {
    expect(stripAnsi("\u001b[38;5;196mred\u001b[0m")).toBe("red");
    expect(stripAnsi("\u001b[48;5;17;1mblue\u001b[0m")).toBe("blue");
  });

  it("removes OSC titles and hyperlinks", () => {
    expect(stripAnsi("\u001b]0;✳ Claude\u0007echo hi")).toBe("echo hi");
    expect(stripAnsi("\u001b]8;;https://example.com\u001b\\link\u001b]8;;\u001b\\")).toBe("link");
    expect(stripAnsi("\u001b]2;title\u009Cdone")).toBe("done");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain 中文 text")).toBe("plain 中文 text");
    expect(stripAnsi("")).toBe("");
  });
});

describe("truncate", () => {
  it("returns short strings unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abc", 10)).toBe("abc");
  });

  it("cuts by code point and marks the cut", () => {
    expect(truncate("abcdef", 3)).toBe("abc…");
    expect(truncate("中文路径测试", 3)).toBe("中文路…");
    expect(truncate("ＡＢＣＤ", 2)).toBe("ＡＢ…");
  });

  it("never splits surrogate pairs", () => {
    const cut = truncate("😀😀😀", 2);
    expect(cut).toBe("😀😀…");
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(cut)).toBe(false);
    expect(truncate("a😀b", 2)).toBe("a😀…");
  });
});

describe("diffStats", () => {
  it("counts added and removed lines", () => {
    const diff = ["--- a/x.ts", "+++ b/x.ts", "-old", "+new", " context", "+again"].join("\n");
    expect(diffStats(diff)).toEqual({ added: 2, removed: 1 });
  });

  it("does not count file headers", () => {
    expect(diffStats("--- a/x.ts\n+++ b/x.ts")).toEqual({ added: 0, removed: 0 });
  });

  it("handles an empty diff", () => {
    expect(diffStats("")).toEqual({ added: 0, removed: 0 });
  });
});

describe("formatTokens", () => {
  it("formats the boundaries", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(1)).toBe("1");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(5400)).toBe("5.4K");
    expect(formatTokens(12345)).toBe("12.3K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("clamps rubbish input to 0", () => {
    expect(formatTokens(-1)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe("0");
  });
});

describe("indicatorText", () => {
  const thinkingLast = assistant([text("done"), { type: "thinking", thinking: "…" }], { stopReason: "pending" });
  const textLast = assistant([{ type: "thinking", thinking: "…" }, text("partial")], { stopReason: "pending" });

  it("hides the line when the streaming block ends in thinking", () => {
    expect(indicatorText({ running: true, streaming: thinkingLast })).toBeNull();
  });

  it("shows the default text when the last streaming block is text", () => {
    expect(indicatorText({ running: true, streaming: textLast })).toBe("思考中…");
  });

  it("shows the default text when nothing is streaming", () => {
    expect(indicatorText({ running: true, streaming: null })).toBe("思考中…");
  });

  it("names a running tool even with a thinking last block", () => {
    expect(indicatorText({ running: true, streaming: thinkingLast, runningTool: "bash" })).toBe(
      "正在运行 bash…",
    );
  });

  it("prefers the extension working message", () => {
    expect(
      indicatorText({ running: true, streaming: thinkingLast, runningTool: "bash", workingMessage: "整理文件" }),
    ).toBe("整理文件");
  });

  it("shows nothing while not running", () => {
    expect(indicatorText({ running: false, streaming: thinkingLast })).toBeNull();
    expect(indicatorText({ running: false, streaming: null })).toBeNull();
  });
});

describe("formatClock", () => {
  it("pads hours and minutes", () => {
    expect(formatClock(new Date(2024, 0, 2, 5, 4).getTime())).toBe("05:04");
    expect(formatClock(new Date(2024, 0, 2, 23, 59).getTime())).toBe("23:59");
  });

  it("returns an empty string for an invalid timestamp", () => {
    expect(formatClock(Number.NaN)).toBe("");
  });
});

describe("turnText", () => {
  it("joins assistant text blocks with a blank line", () => {
    const turns = groupTurns(
      [
        item("u1", user("q")),
        item("a1", assistant([text("one"), { type: "thinking", thinking: "hidden" }, text("two")])),
        item("a2", assistant([text("three"), call("t1", "bash")])),
      ],
      null,
    );
    expect(turnText(turns[0]!)).toBe("one\n\ntwo\n\nthree");
  });

  it("skips blank text blocks and turns without text", () => {
    const turns = groupTurns([item("u1", user("q")), item("a1", assistant([text("  ")]))], null);
    expect(turnText(turns[0]!)).toBe("");
  });
});

describe("toolSummary", () => {
  it("labels bash by the first command line, cut at 80 characters", () => {
    expect(toolSummary(call("1", "bash", { command: "ls -la\nmore" }))).toEqual({
      icon: "Terminal",
      verb: "Bash",
      target: "ls -la",
    });
    expect(toolSummary(call("1", "bash", { command: "x".repeat(120) })).target).toBe(`${"x".repeat(80)}…`);
  });

  it("labels read with a relativized path and line range", () => {
    expect(toolSummary(call("1", "read", { path: "/p/src/a.ts", offset: 10, limit: 51 }), "/p")).toEqual({
      icon: "FileText",
      verb: "读取",
      target: "src/a.ts L10-60",
    });
    expect(toolSummary(call("1", "read", { path: "/p/a.ts", limit: 20 }), "/p").target).toBe("a.ts L1-20");
    expect(toolSummary(call("1", "read", { path: "/p/a.ts" }), "/p").target).toBe("a.ts");
  });

  it("labels edit, write, ls, find and grep", () => {
    expect(toolSummary(call("1", "edit", { path: "/p/a.ts" }), "/p")).toEqual({
      icon: "FilePen",
      verb: "编辑",
      target: "a.ts",
    });
    expect(toolSummary(call("1", "write", { path: "/p/a.ts", content: "a\nb\nc" }), "/p")).toEqual({
      icon: "FilePlus",
      verb: "写入",
      target: "a.ts 3 行",
    });
    expect(toolSummary(call("1", "ls", { path: "/p/src" }), "/p")).toEqual({
      icon: "FolderSearch",
      verb: "列出",
      target: "src",
    });
    expect(toolSummary(call("1", "ls", {}), "/p").target).toBe(".");
    expect(toolSummary(call("1", "find", { pattern: "*.ts" }))).toEqual({
      icon: "Search",
      verb: "查找",
      target: "*.ts",
    });
    expect(toolSummary(call("1", "grep", { pattern: "TODO" }))).toEqual({
      icon: "Search",
      verb: "搜索",
      target: "TODO",
    });
  });

  it("falls back to the tool name and first string argument", () => {
    expect(toolSummary(call("1", "mcp_thing", { query: "hello", n: 1 }))).toEqual({
      icon: "Wrench",
      verb: "mcp_thing",
      target: "hello",
    });
    expect(toolSummary(call("1", "mcp_thing", { query: "中".repeat(70) })).target).toBe(`${"中".repeat(60)}…`);
    expect(toolSummary(call("1", "mcp_thing", { n: 1 })).target).toBe("");
  });
});

describe("guessLanguage", () => {
  it("maps common extensions", () => {
    expect(guessLanguage("/a/b/App.tsx")).toBe("typescript");
    expect(guessLanguage("/a/b/README.md")).toBe("markdown");
    expect(guessLanguage("C:\\a\\b.ts")).toBe("typescript");
    expect(guessLanguage("Makefile")).toBeUndefined();
    expect(guessLanguage("/a/b/weird.unknown")).toBeUndefined();
  });
});

describe("limitHighlight", () => {
  const block = (lines: number) => {
    const code: HastNode = {
      type: "element",
      tagName: "code",
      properties: { className: ["hljs", "language-ts"] },
      children: [
        { type: "text", value: Array.from({ length: lines }, (_, index) => `line ${index + 1}`).join("\n") },
      ],
    };
    const tree: HastNode = { type: "root", children: [{ type: "element", tagName: "pre", children: [code] }] };
    return { tree, code };
  };

  it("keeps highlighting up to the line limit", () => {
    const { tree, code } = block(2000);
    limitHighlight()(tree);
    expect(code.properties?.className).toEqual(["hljs", "language-ts"]);
  });

  it("drops the language class above the line limit", () => {
    const { tree, code } = block(2001);
    limitHighlight()(tree);
    expect(code.properties?.className).toEqual(["hljs"]);
  });
});
