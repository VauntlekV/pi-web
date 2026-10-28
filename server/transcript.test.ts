import { describe, expect, it } from "vitest";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildTranscript } from "./transcript.ts";
import { cleanTitle, fallbackTitle } from "./title.ts";

const ISO = "2026-01-02T03:04:05.000Z";
const millis = Date.parse(ISO);

function base(id: string, parentId: string | null = null) {
  return { id, parentId, timestamp: ISO };
}

function asEntries(entries: unknown[]): SessionEntry[] {
  return entries as SessionEntry[];
}

describe("buildTranscript", () => {
  it("keeps conversation messages and skips system messages and bookkeeping entries", () => {
    const branch = asEntries([
      {
        ...base("system"),
        type: "message",
        message: { role: "system", content: "", timestamp: millis },
      },
      {
        ...base("user", "system"),
        type: "message",
        message: { role: "user", content: "hi", timestamp: millis },
      },
      { ...base("model", "user"), type: "model_change", provider: "p", modelId: "m" },
      {
        ...base("assistant", "model"),
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: millis },
      },
      { ...base("custom-state", "assistant"), type: "custom", customType: "x", data: {} },
      { ...base("label", "custom-state"), type: "label", targetId: "user", label: "mark" },
    ]);

    expect(buildTranscript(branch)).toEqual([
      {
        entryId: "user",
        message: { role: "user", content: "hi", timestamp: millis },
      },
      {
        entryId: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hello" }], timestamp: millis },
      },
    ]);
  });

  it("maps extension messages with display, compaction and branch summaries", () => {
    const branch = asEntries([
      {
        ...base("hidden"),
        type: "custom_message",
        customType: "hidden-type",
        content: "secret",
        display: false,
      },
      {
        ...base("shown"),
        type: "custom_message",
        customType: "shown-type",
        content: "visible",
        display: true,
      },
      {
        ...base("compaction"),
        type: "compaction",
        summary: "older context",
        firstKeptEntryId: "shown",
        tokensBefore: 1234,
      },
      {
        ...base("branch", "compaction"),
        type: "branch_summary",
        summary: "other branch",
        fromId: "shown",
      },
    ]);

    const transcript = buildTranscript(branch);
    expect(transcript).toHaveLength(3);
    expect(transcript[0]).toEqual({
      entryId: "shown",
      message: {
        role: "custom",
        customType: "shown-type",
        content: "visible",
        display: true,
        timestamp: millis,
      },
    });
    expect(transcript[1]).toEqual({
      entryId: "compaction",
      message: {
        role: "compactionSummary",
        summary: "older context",
        tokensBefore: 1234,
        timestamp: millis,
      },
    });
    expect(transcript[2]).toEqual({
      entryId: "branch",
      message: {
        role: "branchSummary",
        summary: "other branch",
        fromId: "shown",
        timestamp: millis,
      },
    });
  });
});

describe("title helpers", () => {
  it("cleans quotes, punctuation, whitespace and line breaks", () => {
    expect(cleanTitle("")).toBe("");
    expect(cleanTitle("   ")).toBe("");
    expect(cleanTitle("\n \t\n")).toBe("");
    expect(cleanTitle('"Hello world."')).toBe("Hello world");
    expect(cleanTitle("“重构认证模块”。")).toBe("重构认证模块");
    expect(cleanTitle("Line one\nLine two")).toBe("Line one");
    expect(cleanTitle("  lots    of\tspace  ")).toBe("lots of space");
    expect(cleanTitle("`code`")).toBe("code");
  });

  it("truncates model titles to 60 characters, emoji included", () => {
    expect(cleanTitle("a".repeat(100))).toHaveLength(60);
    const emoji = cleanTitle("🎉".repeat(100));
    expect(Array.from(emoji)).toHaveLength(60);
  });

  it("falls back to the first user line, capped at 40 characters", () => {
    expect(fallbackTitle("")).toBe("");
    expect(fallbackTitle("  \n\t ")).toBe("");
    expect(fallbackTitle("Fix the login bug\nand then deploy")).toBe("Fix the login bug");
    expect(fallbackTitle("x".repeat(100))).toHaveLength(40);
    expect(Array.from(fallbackTitle("中文".repeat(30)))).toHaveLength(40);
    expect(fallbackTitle("🎉".repeat(100))).toBe("🎉".repeat(40));
    expect(fallbackTitle("  multi   space  ")).toBe("multi space");
  });
});
