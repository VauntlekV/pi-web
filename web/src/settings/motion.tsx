/**
 * 设置 › 动效 — the motion settings, after dsh-claude-style's Motion tab:
 * the global 动画效果 choice, the chat-area follow, the status line (with its
 * precise wording and its two paints), the composer caret, the new-text fade
 * and the sent-message entrance. Every choice with two looks is a pair of live
 * preview cards; under 「减弱」 the cards hold a still frame.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motionReduced, setPrefs, usePrefs, type Prefs } from "../app/prefs.ts";
import { Segmented } from "../ui/segmented.tsx";
import { SwapWords } from "../transcript/status-line.tsx";
import { SettingsGroup, SettingsRow, Switch } from "./controls.tsx";

const MOTION: { value: Prefs["motion"]; label: string }[] = [
  { value: "system", label: "随系统" },
  { value: "reduced", label: "减弱" },
  { value: "full", label: "总是" },
];

const STATUS_SAMPLES = ["正在阅读 README.md", "正在检出当前工作树", "正在思考"];
const CARET_SAMPLE = Array.from("Hello World!");
const REVEAL_SAMPLE = Array.from("新到的字先淡后实");
const BUBBLE_SAMPLES = ["帮我给 pi-web 点个 star", "帮我给 pi-web 提个 issue", "帮我给 pi-web 提个 pr"];

/**
 * A counter cycling 0 … ticks-1 every `periodMs / ticks`; it stands at the
 * last tick (the whole sample) while `still`.
 */
function useCycle(periodMs: number, ticks: number, still: boolean): number {
  const [at, setAt] = useState(still ? ticks - 1 : 0);
  useEffect(() => {
    if (still) {
      setAt(ticks - 1);
      return;
    }
    setAt(0);
    const id = window.setInterval(() => setAt((value) => (value + 1) % ticks), Math.max(16, periodMs / ticks));
    return () => window.clearInterval(id);
  }, [periodMs, ticks, still]);
  return at;
}

interface CardOption<T extends string> {
  value: T;
  label: string;
  content: ReactNode;
  className?: string;
}

function PreviewCards<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: CardOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className={disabled ? "motion-cards is-disabled" : "motion-cards"} role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          aria-label={`${label}：${option.label}`}
          title={option.label}
          disabled={disabled}
          className={option.className ? `motion-card ${option.className}` : "motion-card"}
          onClick={() => onChange(option.value)}
        >
          <span className="motion-card-stage">{option.content}</span>
          <span className="motion-card-label">{option.label}</span>
        </button>
      ))}
    </div>
  );
}

function StatusPreview({ precise, still }: { precise: boolean; still: boolean }) {
  const at = useCycle(STATUS_SAMPLES.length * 2000, STATUS_SAMPLES.length, still || !precise);
  const text = precise ? STATUS_SAMPLES[at]! : "正在思考";
  return (
    <span className="status-line">
      <SwapWords text={text} />
    </span>
  );
}

/** The caret sample: typed out over half the period, then standing whole while the caret blinks. */
function CaretPreview({ at, glide }: { at: number; glide: boolean }) {
  const lineRef = useRef<HTMLSpanElement>(null);
  const barRef = useRef<HTMLSpanElement>(null);
  const typed = Math.min(at, CARET_SAMPLE.length);

  useLayoutEffect(() => {
    const line = lineRef.current;
    const bar = barRef.current;
    if (!line || !bar) return;
    const last = typed === 0 ? null : (line.children[typed - 1] as HTMLElement | undefined);
    const x = last ? last.offsetLeft + last.offsetWidth : 0;
    bar.style.transform = `translateX(${x}px)`;
  }, [typed]);

  return (
    <span className="caret-sample">
      <span className="caret-sample-line" ref={lineRef}>
        {CARET_SAMPLE.map((char, index) => (
          <span key={index} className="caret-sample-char" data-in={index < typed ? "" : undefined}>
            {char}
          </span>
        ))}
      </span>
      <span
        ref={barRef}
        className={glide ? "caret-sample-bar is-glide" : "caret-sample-bar"}
        data-typing={typed < CARET_SAMPLE.length ? "" : undefined}
      />
    </span>
  );
}

function RevealPreview({ at, fade }: { at: number; fade: boolean }) {
  return (
    <span className={fade ? "reveal-sample is-fade" : "reveal-sample"}>
      {REVEAL_SAMPLE.map((char, index) => (
        <span key={index} className="reveal-sample-char" data-in={index < at ? "" : undefined}>
          {char}
        </span>
      ))}
    </span>
  );
}

/** Two bubbles standing, the next one arriving every turn with the chosen entrance. */
function BubblePreview({ turn, style, still }: { turn: number; style: Prefs["messageEnterStyle"]; still: boolean }) {
  const shown = [turn - 1, turn].map((n) => ({ n, text: BUBBLE_SAMPLES[((n % 3) + 3) % 3]! }));
  return (
    <span className="bubble-sample">
      {shown.map(({ n, text }, index) => (
        <span
          key={n}
          className={
            index === 1 && !still ? `bubble-sample-item enter-${style === "grow" ? "grow" : "flight-sample"}` : "bubble-sample-item"
          }
        >
          {text}
        </span>
      ))}
    </span>
  );
}

export function MotionSection() {
  const prefs = usePrefs();
  const still = motionReduced();
  const caretAt = useCycle(4000, CARET_SAMPLE.length * 2, still);
  const revealAt = useCycle(4000, REVEAL_SAMPLE.length * 2, still);
  const bubbleTurn = useCycle(2600 * 1000, 1000, still);

  const stillNote = still ? "动画设为「减弱」时这一项不生效，卡片只显示定格画面。" : undefined;

  return (
    <>
      <SettingsGroup title="动效">
        <SettingsRow title="动画效果" description="请按需调整动画效果。动画会给设备带来渲染压力。">
          <Segmented label="动画效果" value={prefs.motion} options={MOTION} onChange={(motion) => setPrefs({ motion })} />
        </SettingsRow>

        <SettingsRow title="聊天区滚动动画" description="滚动展示助手消息并进行可读性优化">
          <Switch label="聊天区滚动动画" checked={prefs.chatFollow} onChange={(chatFollow) => setPrefs({ chatFollow })} />
        </SettingsRow>

        <div className="settings-row settings-row-block motion-stack">
          <div className="motion-line">
            <span className="settings-row-title">状态行动画</span>
            <Switch label="状态行动画" checked={prefs.statusLine} onChange={(statusLine) => setPrefs({ statusLine })} />
          </div>
          <div className="motion-line">
            <span className="settings-row-title">精确状态行</span>
            <Switch
              label="精确状态行"
              checked={prefs.statusDetail}
              disabled={!prefs.statusLine}
              onChange={(statusDetail) => setPrefs({ statusDetail })}
            />
          </div>
          <PreviewCards
            label="状态行配色"
            value={prefs.statusPaint}
            disabled={!prefs.statusLine}
            onChange={(statusPaint) => setPrefs({ statusPaint })}
            options={[
              {
                value: "sweep",
                label: "扫光",
                className: "paint-sweep",
                content: <StatusPreview precise={prefs.statusDetail} still={still} />,
              },
              {
                value: "wash",
                label: "渐变流动",
                className: "paint-wash",
                content: <StatusPreview precise={prefs.statusDetail} still={still} />,
              },
            ]}
          />
          {stillNote && <span className="settings-row-desc">{stillNote}</span>}
        </div>

        <div className="settings-row settings-row-block motion-stack">
          <span className="settings-row-title">光标动画</span>
          <PreviewCards
            label="光标动画"
            value={prefs.caretMotion ? "on" : "off"}
            onChange={(value) => setPrefs({ caretMotion: value === "on" })}
            options={[
              { value: "on", label: "开", content: <CaretPreview at={caretAt} glide={!still} /> },
              { value: "off", label: "关", content: <CaretPreview at={caretAt} glide={false} /> },
            ]}
          />
          {stillNote && <span className="settings-row-desc">{stillNote}</span>}
        </div>

        <div className="settings-row settings-row-block motion-stack">
          <span className="settings-row-title">新文字淡入</span>
          <PreviewCards
            label="新文字淡入"
            value={prefs.chatReveal ? "on" : "off"}
            onChange={(value) => setPrefs({ chatReveal: value === "on" })}
            options={[
              { value: "on", label: "淡入", content: <RevealPreview at={revealAt} fade={!still} /> },
              { value: "off", label: "直接出现", content: <RevealPreview at={revealAt} fade={false} /> },
            ]}
          />
          {stillNote && <span className="settings-row-desc">{stillNote}</span>}
        </div>

        <div className="settings-row settings-row-block motion-stack">
          <div className="motion-line">
            <span className="settings-row-title">消息气泡动画</span>
            <Switch
              label="消息气泡动画"
              checked={prefs.messageEnter}
              onChange={(messageEnter) => setPrefs({ messageEnter })}
            />
          </div>
          <PreviewCards
            label="消息气泡动画"
            value={prefs.messageEnterStyle}
            disabled={!prefs.messageEnter}
            onChange={(messageEnterStyle) => setPrefs({ messageEnterStyle })}
            options={[
              { value: "grow", label: "在原地长出来", content: <BubblePreview turn={bubbleTurn} style="grow" still={still} /> },
              {
                value: "flight",
                label: "从输入框飞上来",
                content: <BubblePreview turn={bubbleTurn} style="flight" still={still} />,
              },
            ]}
          />
          {stillNote && <span className="settings-row-desc">{stillNote}</span>}
        </div>
      </SettingsGroup>
    </>
  );
}
