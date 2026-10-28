import { Folder } from "lucide-react";
import { useEffect, useState } from "react";
import type {
  ConfigResponse,
  ImageContent,
  ModelInfo,
  ModelRef,
  ThinkingLevel,
  UsageStats,
} from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { basename } from "../app/paths.ts";
import { navigate } from "../app/router.ts";
import { Composer } from "../composer/index.tsx";
import { formatTokens } from "../composer/lib.ts";
import { Segmented } from "../ui/segmented.tsx";
import { toast } from "../ui/toasts.tsx";
import { formatPeakHour, heatCuts, heatDays, heatLevel, modelLabel } from "./lib.ts";
import "./home.css";

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const RANGES: { value: UsageStats["range"]; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "30d", label: "30 天" },
  { value: "7d", label: "7 天" },
];

export interface HomeProps {
  config: ConfigResponse;
  models: ModelInfo[];
  /** Currently selected workspace for the new session */
  cwd: string;
  onPickCwd: () => void;
}

export function Home(props: HomeProps) {
  const { config, models, cwd } = props;
  const [model, setModel] = useState<ModelRef | undefined>(() => {
    if (config.defaultModel) return config.defaultModel;
    const first = models[0];
    return first ? { provider: first.provider, id: first.id } : undefined;
  });
  const [thinking, setThinking] = useState<ThinkingLevel>(config.defaultThinkingLevel);
  const [creating, setCreating] = useState(false);
  const [range, setRange] = useState<UsageStats["range"]>("all");
  const [stats, setStats] = useState<UsageStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);

  const modelInfo = models.find((entry) => entry.provider === model?.provider && entry.id === model?.id);
  const availableThinking: ThinkingLevel[] = modelInfo?.reasoning ? THINKING_LEVELS : ["off"];
  const thinkingLevel = availableThinking.includes(thinking) ? thinking : "off";

  useEffect(() => {
    if (!availableThinking.includes(thinking)) setThinking("off");
  }, [modelInfo, thinking]);

  useEffect(() => {
    let cancelled = false;
    setStatsError(null);
    api.stats(range).then(
      (value) => {
        if (!cancelled) setStats(value);
      },
      (error: unknown) => {
        if (!cancelled) setStatsError(errorText(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [range]);

  const submit = async (text: string, images: ImageContent[]) => {
    setCreating(true);
    try {
      const created = await api.createSession({ cwd, model, thinkingLevel });
      navigate(`/s/${encodeURIComponent(created.state.id)}`);
      try {
        await api.prompt(created.state.id, { text, images });
      } catch (error) {
        toast(errorText(error), "error");
      }
    } finally {
      setCreating(false);
    }
  };

  const cwdChip = (
    <button type="button" className="cwd-chip" title={cwd} onClick={props.onPickCwd}>
      <Folder size={14} />
      <span>{basename(cwd)}</span>
    </button>
  );

  const daily = stats?.daily ?? [];
  const cuts = heatCuts(daily.map((day) => day.tokens));
  const heat = heatDays(daily);
  const metrics = [
    { label: "会话数", value: stats ? String(stats.sessions) : "—" },
    { label: "消息数", value: stats ? String(stats.messages) : "—" },
    { label: "Token 总量", value: stats ? formatTokens(stats.tokens) : "—" },
    { label: "活跃天数", value: stats ? String(stats.activeDays) : "—" },
    { label: "高峰时段", value: stats ? formatPeakHour(stats.peakHour) : "—" },
    { label: "最常用模型", value: stats ? modelLabel(stats.topModel) : "—" },
  ];

  return (
    <div className="home">
      <div className="home-body">
        <div className="home-inner">
          <h1 className="home-greeting">
            <span className="home-mark" aria-hidden="true">
              π
            </span>
            <span>今天想做点什么？</span>
          </h1>

          <section className="home-card" aria-label="用量概览">
            <div className="home-card-head">
              <span className="home-overview">概览</span>
              <Segmented
                className="home-range"
                label="统计范围"
                value={range}
                options={RANGES}
                onChange={setRange}
              />
            </div>

            {statsError ? (
              <p className="home-card-error">{statsError}</p>
            ) : (
              <>
                <div className="home-metrics">
                  {metrics.map((metric) => (
                    <div className="home-metric" key={metric.label}>
                      <span className="home-metric-label">{metric.label}</span>
                      <span className="home-metric-value" title={metric.value}>
                        {metric.value}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="home-heat" role="img" aria-label="每日 Token 用量热力格">
                  {heat.map((day, index) => (
                    <span
                      className="home-heat-cell"
                      key={`${day.date}-${index}`}
                      data-level={heatLevel(day.tokens, cuts)}
                      title={day.outside ? undefined : `${day.date} · ${formatTokens(day.tokens)} tok`}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      </div>

      <div className="home-foot">
        <Composer
          cwd={cwd}
          running={false}
          disabled={creating}
          models={models}
          model={model}
          thinkingLevel={thinkingLevel}
          availableThinkingLevels={availableThinking}
          onModelChange={setModel}
          onThinkingChange={setThinking}
          onSubmit={submit}
          onAbort={() => {}}
          commands={[]}
          leading={cwdChip}
        />
      </div>
    </div>
  );
}
