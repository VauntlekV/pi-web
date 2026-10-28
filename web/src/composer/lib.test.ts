import { describe, expect, it } from "vitest";
import type { CommandInfo, ImageContent } from "../../../shared/protocol.ts";
import {
  applyCompletion,
  clearAfterSubmit,
  detectTrigger,
  filterCommands,
  formatCost,
  formatTokens,
  isWhitespace,
  thinkingLabel,
} from "./lib.ts";

describe("detectTrigger", () => {
  it("does nothing on empty text", () => {
    expect(detectTrigger("", 0)).toBeNull();
  });

  it("does nothing with the caret at 0", () => {
    expect(detectTrigger("/cmd", 0)).toBeNull();
    expect(detectTrigger("@file", 0)).toBeNull();
  });

  it("detects a lone slash", () => {
    expect(detectTrigger("/", 1)).toEqual({ kind: "slash", query: "", start: 0, end: 1 });
  });

  it("detects a slash query", () => {
    expect(detectTrigger("/comp", 5)).toEqual({ kind: "slash", query: "comp", start: 0, end: 5 });
  });

  it("does not trigger slash once the caret is in the arguments", () => {
    expect(detectTrigger("/cmd arg", 8)).toBeNull();
    expect(detectTrigger("/cmd arg", 5)).toBeNull();
  });

  it("ends the slash token at the first whitespace", () => {
    expect(detectTrigger("/cmd arg", 2)).toEqual({ kind: "slash", query: "c", start: 0, end: 4 });
  });

  it("does not treat a slash inside the text as a trigger", () => {
    expect(detectTrigger("a/b", 3)).toBeNull();
    expect(detectTrigger("a/b", 2)).toBeNull();
  });

  it("does not trigger an @ that follows a non-whitespace character", () => {
    expect(detectTrigger("邮箱a@b", 5)).toBeNull();
  });

  it("triggers an @ after a full-width space", () => {
    expect(detectTrigger("你好　@src", 7)).toEqual({ kind: "mention", query: "src", start: 3, end: 7 });
  });

  it("detects a lone @", () => {
    expect(detectTrigger("@", 1)).toEqual({ kind: "mention", query: "", start: 0, end: 1 });
  });

  it("points end at the end of the token when the caret is in the middle", () => {
    expect(detectTrigger("@src/file.ts", 5)).toEqual({
      kind: "mention",
      query: "src/",
      start: 0,
      end: 12,
    });
    expect(detectTrigger("hi @foo bar", 6)).toEqual({ kind: "mention", query: "fo", start: 3, end: 7 });
  });

  it("finds the token after emoji and CJK text", () => {
    expect(detectTrigger("😀你好 @a", 7)).toEqual({ kind: "mention", query: "a", start: 5, end: 7 });
  });

  it("does not trigger when the caret sits in a later token", () => {
    expect(detectTrigger("hi @foo bar", 12)).toBeNull();
  });
});

describe("applyCompletion", () => {
  it("replaces the token and puts the caret after the trailing space", () => {
    const trigger = detectTrigger("/cm", 3)!;
    expect(applyCompletion("/cm", trigger, "/compact ")).toEqual({ text: "/compact ", caret: 9 });
  });

  it("replaces a mention token", () => {
    const trigger = detectTrigger("@src/a", 6)!;
    expect(applyCompletion("@src/a", trigger, "@src/app.ts ")).toEqual({
      text: "@src/app.ts ",
      caret: 12,
    });
  });

  it("leaves the rest of the text in place", () => {
    const trigger = detectTrigger("@fo rest", 3)!;
    expect(applyCompletion("@fo rest", trigger, "@foo ")).toEqual({ text: "@foo  rest", caret: 5 });
  });
});

describe("filterCommands", () => {
  const commands: CommandInfo[] = [
    { name: "cmd", source: "builtin" },
    { name: "model", source: "builtin" },
    { name: "mdx", source: "prompt" },
    { name: "help", source: "extension" },
  ];

  it("puts prefix matches before substring matches", () => {
    expect(filterCommands(commands, "md").map((c) => c.name)).toEqual(["mdx", "cmd"]);
  });

  it("matches case-insensitively", () => {
    expect(filterCommands(commands, "HE").map((c) => c.name)).toEqual(["help"]);
  });

  it("returns everything for an empty query", () => {
    expect(filterCommands(commands, "").map((c) => c.name)).toEqual(["cmd", "model", "mdx", "help"]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterCommands(commands, "zzz")).toEqual([]);
  });
});

describe("clearAfterSubmit", () => {
  const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };
  const otherImage: ImageContent = { type: "image", data: "BBBB", mimeType: "image/png" };

  it("clears an untouched draft", () => {
    const images = [image];
    const sent = { text: "hello", images };
    expect(clearAfterSubmit(sent, { text: "hello", images })).toEqual({ text: "", images: [] });
  });

  it("keeps text typed during the submit and clears the untouched images", () => {
    const images = [image];
    const sent = { text: "hello", images };
    expect(clearAfterSubmit(sent, { text: "hello world", images })).toEqual({
      text: "hello world",
      images: [],
    });
  });

  it("keeps images changed during the submit and clears the untouched text", () => {
    const sent = { text: "hello", images: [] as ImageContent[] };
    const currentImages = [otherImage];
    const result = clearAfterSubmit(sent, { text: "hello", images: currentImages });
    expect(result).toEqual({ text: "", images: [otherImage] });
    expect(result.images).toBe(currentImages);
  });

  it("keeps both when text and images changed", () => {
    const sent = { text: "hello", images: [image] };
    const currentImages = [image, otherImage];
    expect(clearAfterSubmit(sent, { text: "edited", images: currentImages })).toEqual({
      text: "edited",
      images: currentImages,
    });
  });

  it("keeps the draft empty when the user cleared it during the submit", () => {
    const sent = { text: "hello", images: [image] };
    expect(clearAfterSubmit(sent, { text: "", images: sent.images })).toEqual({ text: "", images: [] });
  });

  it("keeps an emptied image list when the user removed images during the submit", () => {
    const sent = { text: "hello", images: [image, otherImage] };
    const result = clearAfterSubmit(sent, { text: "hello", images: [] });
    expect(result).toEqual({ text: "", images: [] });
    expect(result.images).not.toBe(sent.images);
  });
});

describe("labels", () => {
  it("names thinking levels in English", () => {
    expect(thinkingLabel("off")).toBe("off");
    expect(thinkingLabel("minimal")).toBe("minimal");
    expect(thinkingLabel("xhigh")).toBe("xhigh");
    expect(thinkingLabel("max")).toBe("max");
  });
});

describe("formatTokens", () => {
  it("follows the transcript rules", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1000)).toBe("1K");
    expect(formatTokens(5400)).toBe("5.4K");
    expect(formatTokens(12345)).toBe("12.3K");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("clamps junk to zero", () => {
    expect(formatTokens(-5)).toBe("0");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
});

describe("formatCost", () => {
  it("handles the boundaries", () => {
    expect(formatCost(0)).toBe("$0.00");
    expect(formatCost(0.004)).toBe("<$0.01");
    expect(formatCost(0.005)).toBe("$0.01");
    expect(formatCost(1.234)).toBe("$1.23");
  });
});

describe("isWhitespace", () => {
  it("accepts full-width and regular whitespace", () => {
    for (const ch of [" ", "\t", "\n", "\u3000"]) expect(isWhitespace(ch)).toBe(true);
    for (const ch of ["a", "你", ""]) expect(isWhitespace(ch)).toBe(false);
  });
});
