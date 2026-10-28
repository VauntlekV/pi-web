// Shared by the fixture, the E2E specs and the demo recorder (importing
// server.ts would start a server).
export const E2E_PORT = Number(process.env.E2E_PORT ?? 30196);
export const E2E_TOKEN = "e2e-token";
export const E2E_PROMPT = "给 todos 加一个切换完成状态的函数，并补上测试";
export const E2E_TITLE = "实现 toggleTodo 并补测试";
/** First line of the scripted answer */
export const E2E_ANSWER = "已经加好 toggleTodo，并补了一个单元测试。";
export const E2E_COMMIT = "Add toggleTodo and its test";
/** Commits reachable from all refs in the fixture repository */
export const E2E_COMMITS = 6;
