/** Relative timestamps for the sidebar and the recent-session card. */
export function relativeTime(iso: string, now: number): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";

  const diff = now - time;
  if (diff < 0) return "刚刚";

  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "刚刚";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}天`;

  const date = new Date(time);
  const today = new Date(now);
  const month = date.getMonth() + 1;
  if (date.getFullYear() === today.getFullYear()) return `${month}月${date.getDate()}日`;
  return `${date.getFullYear()}/${month}/${date.getDate()}`;
}
