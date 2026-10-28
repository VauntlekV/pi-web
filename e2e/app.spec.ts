// End-to-end checks against e2e/server.ts (faux model, throwaway workspace).
// The tests share one server and one git workspace, so they run in order.
import { expect, test, type Page } from "@playwright/test";
import { E2E_ANSWER, E2E_COMMIT, E2E_COMMITS, E2E_PROMPT, E2E_TITLE, E2E_TOKEN } from "./constants.ts";

test.describe.configure({ mode: "serial" });

async function open(page: Page, path = "/", dock = false) {
  await page.addInitScript((value) => localStorage.setItem("pi-web-dock-open", value), dock ? "1" : "0");
  // The token in the URL sets the auth cookie, then redirects to the bare path.
  await page.goto(`${path}?token=${E2E_TOKEN}`);
  await expect(page.getByRole("textbox", { name: "消息输入" })).toBeVisible();
}

async function openGit(page: Page) {
  await page.locator(".dock-tabs").getByText("Git", { exact: true }).click();
  await expect(page.getByRole("textbox", { name: "提交信息", exact: true })).toBeVisible();
}

test("rejects API calls without the token", async ({ request }) => {
  expect((await request.get("/api/workspaces")).status()).toBe(401);
});

test("a chat turn streams thinking, a tool call and the answer", async ({ page }) => {
  await open(page);
  const input = page.getByRole("textbox", { name: "消息输入" });
  await input.fill(E2E_PROMPT);
  await input.press("Enter");

  await expect(page).toHaveURL(/\/s\//);
  await expect(page.getByText(E2E_ANSWER)).toBeVisible();
  // A finished turn folds its steps; unfolding shows the thinking/tool summary.
  await page.getByText(/^已完成/).click();
  await expect(page.getByText(/调用 2 次工具/)).toBeVisible();
  await expect(page.getByRole("table")).toContainText("node --test");
  // The auto title replaces the first message in the sidebar.
  await expect(page.getByText(E2E_TITLE).first()).toBeVisible();
});

test("the composer + menu keeps a fixed width", async ({ page }) => {
  await open(page);
  await page.getByRole("button", { name: "添加内容" }).click();
  const menu = page.getByRole("menu", { name: "添加内容" });
  await expect(menu).toBeVisible();
  const box = await menu.boundingBox();
  expect(box?.width).toBeLessThanOrEqual(440);
});

test("git panel: graph, stage, AI message, commit", async ({ page }) => {
  await open(page, "/", true);
  await openGit(page);

  // Two branches off main (one merged), a tag, and HEAD on the merge.
  const rows = page.locator(".dock-graph-row");
  const head = page.locator(".dock-graph-row[data-head]");
  await expect(rows).toHaveCount(E2E_COMMITS);
  await expect(head).toContainText("Merge branch 'feature/list-view'");
  await expect(head.locator(".dock-ref[data-kind=head]")).toHaveText("main");
  // Order between unrelated branch tips is up to git; compare as a set.
  const branches = page.locator(".dock-ref[data-kind=branch]");
  await expect(branches).toHaveCount(2);
  expect((await branches.allTextContents()).sort()).toEqual(["feature/list-view", "fix/port"]);
  await expect(page.locator(".dock-ref[data-kind=tag]")).toHaveText("v0.1.0");

  await page.getByRole("button", { name: "全部暂存" }).click();
  await expect(page.locator(".dock-git-group").first()).toContainText("todos.test.js");

  await page.getByRole("button", { name: "AI 生成提交信息" }).click();
  const message = page.getByRole("textbox", { name: "提交信息", exact: true });
  await expect(message).toHaveValue(E2E_COMMIT);

  await page.getByRole("button", { name: "提交", exact: true }).click();
  await expect(page.locator(".dock-git-status")).toContainText("已提交");
  await expect(message).toHaveValue("");
  await expect(head).toContainText(E2E_COMMIT);
  await expect(rows).toHaveCount(E2E_COMMITS + 1);
});

test("the floating commit editor drags and closes with Escape", async ({ page }) => {
  await open(page, "/", true);
  await openGit(page);
  await page.getByRole("button", { name: "悬浮编辑" }).click();

  const dialog = page.getByRole("dialog", { name: "编辑提交信息" });
  await expect(dialog).toBeVisible();
  const before = await dialog.boundingBox();
  const handle = dialog.locator(".dock-float-head");
  const grip = await handle.boundingBox();
  if (!before || !grip) throw new Error("floating editor has no box");
  await page.mouse.move(grip.x + 40, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x - 260, grip.y - 120, { steps: 6 });
  await page.mouse.up();
  const after = await dialog.boundingBox();
  expect(after!.x).toBeLessThan(before.x - 200);
  expect(after!.y).toBeLessThan(before.y - 80);

  // Text typed in the floating editor is the same draft as the header box.
  await dialog.getByRole("textbox").fill("draft from the float");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("textbox", { name: "提交信息", exact: true })).toHaveValue("draft from the float");
});

test("phone width has no horizontal scroll", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
