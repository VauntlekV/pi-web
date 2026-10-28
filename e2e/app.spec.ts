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

test("thinking levels are named in English", async ({ page }) => {
  await open(page);
  const trigger = page.locator(".composer-trigger").last();
  await expect(trigger).toHaveText(/^(off|minimal|low|medium|high|xhigh|max)$/);
  await trigger.click();
  await expect(page.getByRole("listbox", { name: "思考档位" }).getByRole("option").first()).toHaveText("off");
});

test("the slash command list follows ↑/↓ past its edge", async ({ page }) => {
  const commands = [
    ...Array.from({ length: 30 }, (_, index) => ({
      name: `cmd-${String(index).padStart(2, "0")}`,
      description: `command ${index}`,
      source: "prompt",
    })),
    { name: "skill:ponytail-review", description: "Quality review of a change: is the logic right, is it safe, does it hold under real load".repeat(2), source: "skill" },
  ];
  await page.route("**/api/sessions/*/commands", (route) => route.fulfill({ json: { commands } }));
  await open(page);
  // Commands load per session; start an empty one of our own.
  const { defaultCwd } = (await (await page.request.get("/api/config")).json()) as { defaultCwd: string };
  const created = (await (await page.request.post("/api/sessions", { data: { cwd: defaultCwd } })).json()) as { state: { id: string } };
  await page.goto(`/s/${created.state.id}`);

  const input = page.getByRole("textbox", { name: "消息输入" });
  await input.fill("/cmd");
  const list = page.getByRole("listbox", { name: "命令" });
  await expect(list.getByRole("option")).toHaveCount(30);

  const inView = async (name: string) => {
    const row = await list.getByRole("option", { name: new RegExp(name) }).boundingBox();
    const box = await list.boundingBox();
    return Boolean(row && box && row.y >= box.y - 1 && row.y + row.height <= box.y + box.height + 1);
  };
  // ↑ from the first row wraps to the last one, far below the fold.
  await input.press("ArrowUp");
  await expect.poll(() => inView("cmd-29")).toBe(true);
  // ↓ wraps back to the top.
  await input.press("ArrowDown");
  await expect.poll(() => inView("cmd-00")).toBe(true);
  for (let step = 0; step < 15; step++) await input.press("ArrowDown");
  await expect.poll(() => inView("cmd-15")).toBe(true);

  // A long skill name stays readable next to a long description, even on a phone.
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill("/skill");
  const name = list.locator(".composer-completion-name", { hasText: "ponytail-review" });
  await expect(name).toBeVisible();
  expect(await name.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await input.fill("");
});

async function openModelSettings(page: Page) {
  await open(page);
  await page.locator(".sidebar").getByText("pi", { exact: true }).last().click();
  await page.getByRole("menuitem", { name: /设置/ }).click();
  await page.getByRole("button", { name: "模型", exact: true }).click();
  await expect(page.getByRole("heading", { name: "模型" })).toBeVisible();
}

test("model editor: override a built-in model, then revert", async ({ page }) => {
  await openModelSettings(page);
  await page.getByRole("button", { name: "编辑", exact: true }).first().click();
  const row = page.locator(".provider-model", { hasText: "demo-coder" });
  await expect(row).toContainText("200K");

  await page.getByRole("button", { name: "编辑 Demo Coder" }).click();
  await page.getByRole("textbox", { name: "上下文窗口" }).fill("300000");
  await page.getByRole("textbox", { name: "输入价格" }).fill("1.5");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await expect(row).toContainText("300K");
  await expect(row).toContainText("已修改");

  await page.getByRole("button", { name: "编辑 Demo Coder" }).click();
  await expect(page.getByRole("textbox", { name: "输入价格" })).toHaveValue("1.5");
  await page.getByRole("button", { name: "还原默认" }).click();
  await expect(row).toContainText("200K");
  await expect(row).not.toContainText("已修改");
});

test("model editor: create a custom provider, add a model, delete it", async ({ page }) => {
  await openModelSettings(page);
  await page.getByRole("button", { name: "添加模型提供商" }).click();
  await page.getByRole("button", { name: /自定义提供商/ }).click();
  await page.getByRole("textbox", { name: "提供商 ID" }).fill("local");
  await page.getByRole("textbox", { name: "Base URL" }).fill("http://127.0.0.1:9/v1");
  await page.getByRole("button", { name: "创建" }).click();

  const card = page.locator(".provider-card", { hasText: "自定义" });
  await expect(card.locator(".provider-name").first()).toHaveText("local");
  await card.getByRole("button", { name: "手动添加模型" }).click();
  await card.getByRole("textbox", { name: "新模型 ID" }).fill("qwen3-coder");
  await card.getByRole("button", { name: "添加", exact: true }).click();
  await expect(card.locator(".provider-model", { hasText: "qwen3-coder" })).toBeVisible();

  // models.dev fills the empty fields. "local" is not the listing provider and only
  // one listing has a price, so the price is withheld as unreliable.
  await card.getByRole("button", { name: "编辑 qwen3-coder" }).click();
  await card.getByRole("button", { name: "从 models.dev 填充" }).click();
  await expect(card.getByRole("status")).toContainText("已填充");
  await expect(card.getByRole("status")).toContainText("只有一家第三方列出价格");
  await expect(card.getByRole("textbox", { name: "上下文窗口" })).toHaveValue("262144");
  await expect(card.getByRole("textbox", { name: "显示名称", exact: true })).toHaveValue("Qwen3 Coder");
  await expect(card.getByRole("textbox", { name: "输出价格" })).toHaveValue("");
  await card.getByRole("button", { name: "保存", exact: true }).click();
  await expect(card.locator(".provider-model", { hasText: "Qwen3 Coder" })).toContainText("262K");

  // Nothing listens on port 9: discovery reports the failure instead of hanging.
  await card.getByRole("button", { name: "从接口获取模型" }).click();
  await expect(card.getByRole("alert")).toContainText("127.0.0.1:9");
  await card.getByRole("button", { name: "关闭" }).click();

  await card.getByRole("button", { name: "删除提供商" }).click();
  await card.getByRole("button", { name: "确认删除" }).click();
  await expect(page.locator(".provider-card", { hasText: "自定义" })).toHaveCount(0);
});
