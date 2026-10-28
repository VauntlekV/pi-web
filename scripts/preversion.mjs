// `npm version <patch|minor|major>` guard: release only a clean, pushed main.
// The tag push then runs .github/workflows/release.yml (full CI + npm publish).
import { execFileSync } from "node:child_process";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const fail = (message) => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") fail("只能在 main 分支上发版");
if (git("status", "--porcelain")) fail("工作区有未提交的改动");
git("fetch", "-q", "origin", "main");
if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) fail("main 和 origin/main 不一致，先 pull / push");
