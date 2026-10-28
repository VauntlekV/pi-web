/**
 * Trajectory — 轨迹 view: every transcript entry as one dense row (role badge,
 * summary, tool args → result) with a timeline strip on top.
 *
 * CONTRACT: the conversation renders <Trajectory .../> instead of <Transcript/>
 * when the header segment is 轨迹. The parent owns scrolling.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { AssistantMessage, TranscriptItem } from "../../../shared/protocol.ts";
import { buildBands, buildRows, filterRows, type RowFilter } from "./rows.ts";
import "./trajectory.css";

export interface TrajectoryProps {
  items: TranscriptItem[];
  streaming: AssistantMessage | null;
  cwd?: string;
}

const FILTERS: { value: RowFilter; label: string }[] = [
  { value: "all", label: "全部" },
  { value: "message", label: "消息" },
  { value: "tool", label: "工具" },
];

const LANES = ["输入", "模型", "工具"];

export function Trajectory({ items, streaming }: TrajectoryProps) {
  const [filter, setFilter] = useState<RowFilter>("all");
  const [query, setQuery] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);

  const rows = useMemo(() => buildRows(items, streaming), [items, streaming]);
  const shown = useMemo(() => filterRows(rows, filter, query), [rows, filter, query]);
  const bands = useMemo(() => buildBands(rows), [rows]);

  return (
    <div className="trajectory">
      <div className="tray-toolbar">
        <div className="tray-seg" role="group" aria-label="过滤记录">
          {FILTERS.map((option) => (
            <button
              key={option.value}
              type="button"
              className="tray-seg-btn"
              aria-pressed={filter === option.value}
              onClick={() => setFilter(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <label className="tray-search">
          <Search size={14} strokeWidth={1.75} aria-hidden />
          <input
            type="search"
            value={query}
            placeholder="搜索"
            aria-label="搜索轨迹"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      </div>

      <div className="tray-timeline" aria-hidden>
        <div className="tray-lane-labels">
          {LANES.map((label) => (
            <span key={label} className="tray-lane-label">
              {label}
            </span>
          ))}
        </div>
        <div className="tray-strip">
          {LANES.map((label, lane) => (
            <div key={label} className="tray-band-row">
              {bands
                .filter((band) => band.lane === lane)
                .map((band) => (
                  <span
                    key={band.id}
                    className={`tray-band tray-band-${lane}`}
                    style={{ left: `${band.left}%`, width: `${band.width}%` }}
                  />
                ))}
            </div>
          ))}
        </div>
      </div>

      <div className="tray-rows">
        {shown.map((row, index) => {
          const firstOfTurn = index === 0 || shown[index - 1]!.turn !== row.turn;
          const open = openKey === row.key;
          return (
            <div className="tray-record" key={row.key}>
              <div className="tray-record-row">
                <span className="tray-turn">{firstOfTurn ? `第 ${row.turn + 1} 轮` : ""}</span>
                <button
                  type="button"
                  className={`tray-row${open ? " is-open" : ""}`}
                  aria-expanded={open}
                  onClick={() => setOpenKey(open ? null : row.key)}
                >
                  <span className={`tray-badge tray-badge-${row.role}`}>{row.badge}</span>
                  <span className="tray-text">
                    {row.tool ? (
                      <>
                        <span className="tray-tool-call">
                          {row.tool.name} {row.tool.args}
                        </span>
                        {row.tool.result ? (
                          <>
                            <span className="tray-arrow"> → </span>
                            <span className="tray-result">{row.tool.result}</span>
                          </>
                        ) : null}
                      </>
                    ) : (
                      row.text
                    )}
                  </span>
                </button>
              </div>
              {open ? <pre className="tray-detail">{row.detail}</pre> : null}
            </div>
          );
        })}
        {shown.length === 0 ? <div className="tray-empty">没有匹配的记录</div> : null}
      </div>
    </div>
  );
}
