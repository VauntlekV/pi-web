import { describe, expect, it } from "vitest";
import { REVEAL_MS, REVEAL_STAGGER_MS, REVEAL_STEPS, revealStep } from "./reveal.ts";
import { statusWords, type Step } from "./turns.ts";

const step = (over: Partial<Step>): Step => ({ key: "k", kind: "tool", icon: "Wrench", verb: "读取", target: "", status: "running", ...over }) as Step;

describe("statusWords", () => {
  it("names the step in flight when precise", () => {
    expect(statusWords([step({ path: "docs/README.md", target: "docs/README.md" })], true)).toBe("正在读取 README.md");
    expect(statusWords([step({ verb: "运行命令", target: "npm test\nmore" })], true)).toBe("正在运行命令 npm test");
  });

  it("keeps to the bare state when not precise", () => {
    expect(statusWords([step({ path: "a.ts" })], false)).toBe("正在调用工具");
    expect(statusWords([step({ kind: "thinking" as Step["kind"] })], false)).toBe("正在思考");
  });

  it("reads thinking before the first step and after a finished tool", () => {
    expect(statusWords([], true)).toBe("正在思考");
    expect(statusWords([step({ status: "done", path: "a.ts" })], true)).toBe("正在思考");
  });

  it("says 正在写回答 while the answer streams, and an extension's message wins", () => {
    expect(statusWords([step({ path: "a.ts" })], true, undefined, true)).toBe("正在写回答");
    expect(statusWords([], true, "正在部署", true)).toBe("正在部署");
  });
});

describe("revealStep", () => {
  it("rises through the steps and ends once the fade is over", () => {
    expect(revealStep(0)).toBe(0);
    expect(revealStep(-5)).toBe(0);
    expect(revealStep(REVEAL_MS / 2)).toBe(REVEAL_STEPS / 2);
    expect(revealStep(REVEAL_MS - 1)).toBe(REVEAL_STEPS - 1);
    expect(revealStep(REVEAL_MS)).toBe(-1);
  });

  it("staggers within dsh's 1–8ms bounds", () => {
    expect(REVEAL_STAGGER_MS).toBeGreaterThanOrEqual(1);
    expect(REVEAL_STAGGER_MS).toBeLessThanOrEqual(8);
  });
});
