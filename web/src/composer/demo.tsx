/**
 * Demo page for the composer: fake models, commands and stats, a running
 * toggle and a log of submits. Open /demo-composer.html (add ?theme=dark for
 * the dark palette).
 */
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  CommandInfo,
  ImageContent,
  ModelInfo,
  ModelRef,
  SessionStats,
  ThinkingLevel,
} from "../../../shared/protocol.ts";
import { Composer } from "./index.tsx";
import "../styles/tokens.css";
import "../styles/base.css";
import "./demo.css";

if (new URLSearchParams(window.location.search).get("theme") === "dark") {
  document.documentElement.dataset.theme = "dark";
}

const models: ModelInfo[] = [
  { provider: "pi", id: "pi-code", name: "π Code", reasoning: true, contextWindow: 200_000, maxTokens: 64_000, vision: true },
  { provider: "pi", id: "pi-code-mini", name: "π Code Mini", reasoning: true, contextWindow: 128_000, maxTokens: 32_000, vision: true },
  { provider: "pi", id: "pi-reasoner", name: "π Reasoner", reasoning: true, contextWindow: 200_000, maxTokens: 64_000, vision: false },
  { provider: "pi", id: "pi-reasoner-max", name: "π Reasoner Max", reasoning: true, contextWindow: 400_000, maxTokens: 128_000, vision: false },
  { provider: "openrouter", id: "llama-4-scout", name: "Llama 4 Scout", reasoning: false, contextWindow: 128_000, maxTokens: 16_000, vision: true },
  { provider: "openrouter", id: "llama-4-maverick", name: "Llama 4 Maverick", reasoning: false, contextWindow: 128_000, maxTokens: 16_000, vision: true },
  { provider: "openrouter", id: "mistral-large", name: "Mistral Large", reasoning: false, contextWindow: 128_000, maxTokens: 32_000, vision: false },
  { provider: "openrouter", id: "qwen3-coder", name: "Qwen3 Coder", reasoning: true, contextWindow: 256_000, maxTokens: 32_000, vision: false },
  { provider: "local", id: "ollama-qwen", name: "Ollama Qwen 32B", reasoning: false, contextWindow: 32_000, maxTokens: 8_000, vision: false },
  { provider: "local", id: "ollama-llama", name: "Ollama Llama 8B", reasoning: false, contextWindow: 16_000, maxTokens: 4_000, vision: false },
  { provider: "local", id: "local-vision", name: "Local Vision", reasoning: false, contextWindow: 32_000, maxTokens: 8_000, vision: true },
  { provider: "local", id: "local-small", name: "Local Small", reasoning: true, contextWindow: 8_000, maxTokens: 2_000, vision: false },
];

const commands: CommandInfo[] = [
  { name: "compact", description: "压缩当前上下文，保留摘要", source: "builtin" },
  { name: "model", description: "切换会话使用的模型", source: "builtin" },
  { name: "clear", description: "清空当前对话", source: "builtin" },
  { name: "help", description: "显示快捷键与用法", source: "extension" },
  { name: "test", description: "运行项目测试并汇报结果", source: "extension" },
  { name: "deploy", description: "把构建产物部署到预发环境", source: "extension" },
  { name: "review", description: "审查当前的改动", source: "prompt" },
  { name: "commit", description: "根据 diff 生成提交信息", source: "prompt" },
  { name: "docs", description: "为模块补充文档注释", source: "skill" },
  { name: "explain", description: "解释选中的代码", source: "skill" },
];

const stats: SessionStats = {
  userMessages: 4,
  assistantMessages: 5,
  toolCalls: 9,
  tokens: { input: 82_400, output: 12_300, cacheRead: 40_000, cacheWrite: 9_500, total: 174_000 },
  cost: 0.12,
  contextUsage: { tokens: 174_000, contextWindow: 200_000, percent: 87 },
};

const levels: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

interface LogEntry {
  time: string;
  text: string;
  result: "ok" | "error" | "abort";
}

function Demo() {
  const [running, setRunning] = useState(false);
  const [model, setModel] = useState<ModelRef>({ provider: "pi", id: "pi-code" });
  const [thinking, setThinking] = useState<ThinkingLevel>("high");
  const [log, setLog] = useState<LogEntry[]>([]);

  const append = (entry: LogEntry) => setLog((previous) => [...previous, entry]);

  const onSubmit = async (
    text: string,
    _images: ImageContent[],
    behavior?: "steer" | "followUp",
  ) => {
    await new Promise((resolve) => window.setTimeout(resolve, 300));
    const time = new Date().toLocaleTimeString();
    if (text.toLowerCase().includes("fail")) {
      append({ time, text: `失败（${behavior ?? "send"}）：${text}`, result: "error" });
      throw new Error("模拟失败：文本包含 fail");
    }
    append({ time, text: `发送（${behavior ?? "send"}）：${text}`, result: "ok" });
  };

  return (
    <div className="demo">
      <header className="demo-head">
        <span>
          composer demo · {model.provider}/{model.id} · 思考 {thinking}
        </span>
        <button type="button" className="demo-button" onClick={() => setRunning((value) => !value)}>
          {running ? "停止运行" : "开始运行"}
        </button>
      </header>

      <main className="demo-log">
        {log.length === 0 && <p className="demo-empty">发送消息后，日志显示在这里。输入含 “fail” 的文本可测试失败态。</p>}
        {log.map((entry, index) => (
          <div key={index} className="demo-log-entry" data-result={entry.result}>
            <span className="demo-log-time">{entry.time}</span>
            <span>{entry.text}</span>
          </div>
        ))}
      </main>

      <div className="demo-composer">
        <Composer
          cwd="/home/user/projects/pi-web"
          running={running}
          models={models}
          model={model}
          thinkingLevel={thinking}
          availableThinkingLevels={levels}
          onModelChange={setModel}
          onThinkingChange={setThinking}
          commands={commands}
          stats={stats}
          queued={{
            steering: ["顺便把暗色模式也检查一下"],
            followUp: ["运行完成后补一份总结"],
          }}
          widgets={{
            plan: {
              lines: ["下一步：补全输入卡片的键盘行为", "目标：纯函数全部有单测"],
              placement: "aboveEditor",
            },
          }}
          statuses={{ branch: "main · 3 个未提交改动" }}
          onSubmit={onSubmit}
          onAbort={() => {
            append({ time: new Date().toLocaleTimeString(), text: "中止", result: "abort" });
            setRunning(false);
          }}
        />
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Demo />
  </StrictMode>,
);
