/** Pure helpers for the home page's usage card and heat grid. */

/** 0–23 local hour → 「上午 5 点」/「下午 3 点」; null → 「—」. */
export function formatPeakHour(hour: number | null | undefined): string {
  if (hour === null || hour === undefined || !Number.isInteger(hour) || hour < 0 || hour > 23) return "—";
  if (hour === 0) return "午夜 12 点";
  if (hour === 12) return "中午 12 点";
  if (hour < 12) return `上午 ${hour} 点`;
  if (hour < 18) return `下午 ${hour - 12} 点`;
  return `晚上 ${hour - 12} 点`;
}

/** The 25/50/75% cuts of the non-zero values, ascending; empty when all are zero. */
export function heatCuts(values: number[]): number[] {
  const nonZero = values.filter((value) => value > 0).sort((a, b) => a - b);
  if (nonZero.length === 0) return [];
  return [0.25, 0.5, 0.75].map(
    (q) => nonZero[Math.min(nonZero.length - 1, Math.floor(nonZero.length * q))]!,
  );
}

/** Heat level: 0 for no tokens, else 1–4 by how many quartile cuts it reaches. */
export function heatLevel(tokens: number, cuts: number[]): number {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  let level = 1;
  for (const cut of cuts) {
    if (tokens >= cut) level += 1;
  }
  return Math.min(4, level);
}

/** Provider prefix removed: "anthropic/claude" → "claude". */
export function modelLabel(topModel: string | null | undefined): string {
  if (!topModel) return "—";
  const slash = topModel.indexOf("/");
  return slash >= 0 ? topModel.slice(slash + 1) : topModel;
}

/** Day-of-week index (0 = Sunday) of a "YYYY-MM-DD" date, in local time. */
export function weekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number);
  if (!year || !month || !day) return 0;
  return new Date(year, month - 1, day).getDay();
}

export interface HeatDay {
  date: string;
  tokens: number;
  /** Padded day outside the reported window (the grid always spans whole weeks) */
  outside?: boolean;
}

function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The heat grid's 26 whole weeks (182 Sunday–Saturday cells) ending with the
 * week of the newest entry. Older days of a mid-week window simply fall off the
 * left edge; days after the newest one are padded (nothing was reported yet).
 */
export function heatDays(daily: { date: string; tokens: number }[]): HeatDay[] {
  const last = daily[daily.length - 1];
  if (!last) return [];
  const byDate = new Map(daily.map((day) => [day.date, day]));
  const [year, month, day] = last.date.split("-").map(Number);
  const end = new Date(year ?? 1970, (month ?? 1) - 1, day ?? 1);
  end.setDate(end.getDate() + (6 - weekday(last.date)));

  const cells: HeatDay[] = [];
  for (let offset = 181; offset >= 0; offset -= 1) {
    const cursor = new Date(end.getFullYear(), end.getMonth(), end.getDate() - offset);
    const date = dayKey(cursor);
    const entry = byDate.get(date);
    cells.push(entry ? { date, tokens: entry.tokens } : { date, tokens: 0, outside: true });
  }
  return cells;
}
