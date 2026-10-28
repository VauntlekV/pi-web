import { describe, expect, it } from "vitest";
import { ellipsizeLeft, fileIcon, gitLetter, parseUnifiedDiff, relativeTime, splitPath } from "./lib.ts";

describe("parseUnifiedDiff", () => {
  it("parses multiple hunks with old and new line numbers", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "index 1111111..2222222 100644",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,3 +1,4 @@ export function a() {",
      " one",
      "-two",
      "+two changed",
      "+two and a half",
      " three",
      "@@ -10,2 +11,2 @@ function b() {",
      "-old",
      "+new",
    ].join("\n");

    const hunks = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);

    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 3, newStart: 1, newCount: 4 });
    expect(hunks[0]!.header).toBe("@@ -1,3 +1,4 @@ export function a() {");
    expect(hunks[0]!.lines).toEqual([
      { kind: "context", text: "one", oldLine: 1, newLine: 1 },
      { kind: "del", text: "two", oldLine: 2, newLine: null },
      { kind: "add", text: "two changed", oldLine: null, newLine: 2 },
      { kind: "add", text: "two and a half", oldLine: null, newLine: 3 },
      { kind: "context", text: "three", oldLine: 3, newLine: 4 },
    ]);

    expect(hunks[1]).toMatchObject({ oldStart: 10, oldCount: 2, newStart: 11, newCount: 2 });
    expect(hunks[1]!.lines).toEqual([
      { kind: "del", text: "old", oldLine: 10, newLine: null },
      { kind: "add", text: "new", oldLine: null, newLine: 11 },
    ]);
  });

  it("handles a new file diffed against /dev/null", () => {
    const hunks = parseUnifiedDiff(
      [
        "diff --git a/new.txt b/new.txt",
        "new file mode 100644",
        "index 0000000..e69de29",
        "--- /dev/null",
        "+++ b/new.txt",
        "@@ -0,0 +1,2 @@",
        "+hello",
        "+world",
      ].join("\n"),
    );

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 0, oldCount: 0, newStart: 1, newCount: 2 });
    expect(hunks[0]!.lines).toEqual([
      { kind: "add", text: "hello", oldLine: null, newLine: 1 },
      { kind: "add", text: "world", oldLine: null, newLine: 2 },
    ]);
  });

  it("handles a deleted file diffed against /dev/null", () => {
    const hunks = parseUnifiedDiff(
      ["diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1,2 +0,0 @@", "-bye", "-bye again"].join(
        "\n",
      ),
    );

    expect(hunks).toHaveLength(1);
    expect(hunks[0]).toMatchObject({ oldStart: 1, oldCount: 2, newStart: 0, newCount: 0 });
    expect(hunks[0]!.lines).toEqual([
      { kind: "del", text: "bye", oldLine: 1, newLine: null },
      { kind: "del", text: "bye again", oldLine: 2, newLine: null },
    ]);
  });

  it("skips no-newline markers without consuming line numbers", () => {
    const hunks = parseUnifiedDiff(
      ["@@ -1 +1 @@", "-a", "\\ No newline at end of file", "+b", "\\ No newline at end of file"].join("\n"),
    );

    expect(hunks[0]!.lines).toEqual([
      { kind: "del", text: "a", oldLine: 1, newLine: null },
      { kind: "add", text: "b", oldLine: null, newLine: 1 },
    ]);
  });

  it("keeps content lines that look like file headers inside a hunk", () => {
    const hunks = parseUnifiedDiff(
      ["@@ -1,3 +1,3 @@", " --- header-looking context", "+++ header-looking add", "--- header-looking del"].join("\n"),
    );

    expect(hunks).toHaveLength(1);
    expect(hunks[0]!.lines).toEqual([
      { kind: "context", text: "--- header-looking context", oldLine: 1, newLine: 1 },
      { kind: "add", text: "++ header-looking add", oldLine: null, newLine: 2 },
      { kind: "del", text: "-- header-looking del", oldLine: 2, newLine: null },
    ]);
  });

  it("normalises CRLF line endings", () => {
    const hunks = parseUnifiedDiff("@@ -1,2 +1,2 @@\r\n-a\r\n+b\r\n c\r\n");

    expect(hunks[0]!.lines).toEqual([
      { kind: "del", text: "a", oldLine: 1, newLine: null },
      { kind: "add", text: "b", oldLine: null, newLine: 1 },
      { kind: "context", text: "c", oldLine: 2, newLine: 2 },
    ]);
  });

  it("returns nothing for an empty or non-diff text", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("diff --git a/a b/a\nindex 111..222\n")).toEqual([]);
  });
});

describe("gitLetter", () => {
  it("maps git change kinds to one letter", () => {
    expect(gitLetter("modified")).toBe("M");
    expect(gitLetter("typechange")).toBe("M");
    expect(gitLetter("added")).toBe("A");
    expect(gitLetter("deleted")).toBe("D");
    expect(gitLetter("renamed")).toBe("R");
    expect(gitLetter("copied")).toBe("R");
    expect(gitLetter("untracked")).toBe("U");
    expect(gitLetter("conflicted")).toBe("U");
  });
});

describe("splitPath", () => {
  it("splits relative and absolute paths", () => {
    expect(splitPath("src/app/main.ts")).toEqual({ dir: "src/app", name: "main.ts" });
    expect(splitPath("README.md")).toEqual({ dir: "", name: "README.md" });
    expect(splitPath("/home/user/work")).toEqual({ dir: "/home/user", name: "work" });
    expect(splitPath("/work")).toEqual({ dir: "/", name: "work" });
  });
});

describe("ellipsizeLeft", () => {
  it("keeps short paths untouched", () => {
    expect(ellipsizeLeft("/a/b", 10)).toBe("/a/b");
  });

  it("counts code points, not UTF-16 units", () => {
    const path = "/很深的目录/文件.ts";
    const result = ellipsizeLeft(path, 6);
    expect(result.startsWith("…")).toBe(true);
    expect(Array.from(result)).toHaveLength(6);
    expect(result).toBe("…文件.ts");
  });

  it("never splits an emoji", () => {
    const result = ellipsizeLeft("📁📁📁📁📁", 3);
    expect(result).toBe("…📁📁");
    expect(Array.from(result)).toHaveLength(3);
  });

  it("degrades to a single ellipsis", () => {
    expect(ellipsizeLeft("abcdef", 1)).toBe("…");
    expect(ellipsizeLeft("abcdef", 0)).toBe("…");
  });
});

describe("fileIcon", () => {
  it("classifies by extension, case-insensitively", () => {
    expect(fileIcon("src/main.ts")).toBe("code");
    expect(fileIcon("README.MD")).toBe("markdown");
    expect(fileIcon("logo.png")).toBe("image");
    expect(fileIcon("LICENSE")).toBe("file");
    expect(fileIcon(".gitignore")).toBe("file");
    expect(fileIcon("Dockerfile")).toBe("code");
  });
});

describe("relativeTime", () => {
  const now = Date.parse("2025-06-15T12:00:00Z");

  it("uses the sidebar's buckets", () => {
    expect(relativeTime("2025-06-15T11:59:30Z", now)).toBe("刚刚");
    expect(relativeTime("2025-06-15T11:55:00Z", now)).toBe("5分钟");
    expect(relativeTime("2025-06-15T09:00:00Z", now)).toBe("3小时");
    expect(relativeTime("2025-06-13T12:00:00Z", now)).toBe("2天");
    expect(relativeTime("2025-05-30T12:00:00Z", now)).toBe("5月30日");
    expect(relativeTime("not a date", now)).toBe("");
  });
});
