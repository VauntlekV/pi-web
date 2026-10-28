import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UsageStats } from "../../shared/protocol.ts";
import { statsIo } from "./stats.ts";
import { createSettingsHarness } from "./testing.ts";

const now = new Date();
const at = (daysAgo: number, hour: number, minute = 0): Date =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, hour, minute, 0, 0);
const localDay = (date: Date): string =>
  `${date.getFullYear()}-${`${date.getMonth() + 1}`.padStart(2, "0")}-${`${date.getDate()}`.padStart(2, "0")}`;

function header(id: string, timestamp: Date): string {
  return JSON.stringify({ type: "session", version: 3, id, timestamp: timestamp.toISOString(), cwd: "/tmp/work" });
}

let counter = 0;
function message(timestamp: Date, role: "user" | "assistant", extra: Record<string, unknown> = {}): string {
  counter += 1;
  return JSON.stringify({
    type: "message",
    id: `entry-${counter}`,
    parentId: null,
    timestamp: timestamp.toISOString(),
    message: { role, content: `${role} text`, timestamp: timestamp.getTime(), ...extra },
  });
}

const assistant = (timestamp: Date, totalTokens: number, provider = "faux", model = "faux-1"): string =>
  message(timestamp, "assistant", { provider, model, usage: { totalTokens } });

describe("stats", () => {
  it("aggregates messages, tokens, active days, peak hour, models, and a 182-day chart", async () => {
    const h = await createSettingsHarness();
    try {
      const today = at(0, 10);
      const yesterday = at(1, 15);
      const old = at(40, 9);
      const s1 = [
        header("s1", at(1, 15)),
        message(today, "user"),
        assistant(at(0, 10, 5), 100),
        assistant(at(0, 11), 50),
        "this line is not JSON",
        JSON.stringify({ type: "session_info", id: "x", parentId: null, timestamp: today.toISOString(), name: "ignored" }),
        message(yesterday, "user"),
        assistant(at(1, 15, 1), 25, "faux", "faux-2"),
      ].join("\n");
      const s2 = [header("s2", old), message(old, "user"), assistant(at(40, 9, 1), 10, "other", "m1")].join("\n");
      await writeFile(join(h.sessionDir, "s1.jsonl"), `${s1}\n`);
      await writeFile(join(h.sessionDir, "s2.jsonl"), `${s2}\n`);

      const all = await h.json<UsageStats>("/api/stats?range=all");
      expect(all.status).toBe(200);
      expect(all.body.range).toBe("all");
      expect(all.body.sessions).toBe(2);
      expect(all.body.messages).toBe(7);
      expect(all.body.tokens).toBe(185);
      expect(all.body.activeDays).toBe(3);
      expect(all.body.peakHour).toBe(9);
      expect(all.body.topModel).toBe("faux/faux-1");
      expect(all.body.daily).toHaveLength(182);

      const last = all.body.daily[181]!;
      expect(last).toEqual({ date: localDay(at(0, 0)), tokens: 150, messages: 3 });
      expect(all.body.daily[180]).toEqual({ date: localDay(at(1, 0)), tokens: 25, messages: 2 });
      expect(all.body.daily[141]).toEqual({ date: localDay(at(40, 0)), tokens: 10, messages: 2 });

      const week = await h.json<UsageStats>("/api/stats?range=7d");
      expect(week.body.range).toBe("7d");
      expect(week.body.sessions).toBe(1);
      expect(week.body.messages).toBe(5);
      expect(week.body.tokens).toBe(175);
      expect(week.body.activeDays).toBe(2);
      expect(week.body.peakHour).toBe(10);
      expect(week.body.topModel).toBe("faux/faux-1");
      expect(week.body.daily).toHaveLength(182);

      const month = await h.json<UsageStats>("/api/stats?range=30d");
      expect(month.body.sessions).toBe(1);
      expect(month.body.tokens).toBe(175);
    } finally {
      await h.close();
    }
  });

  it("does not read unchanged session files again on the next request", async () => {
    const h = await createSettingsHarness();
    try {
      const today = at(0, 12);
      for (const [index, timestamp] of [today, at(1, 9)].entries()) {
        const text = [header(`s${index}`, timestamp), message(timestamp, "user"), assistant(timestamp, 10)].join("\n");
        await writeFile(join(h.sessionDir, `s${index}.jsonl`), `${text}\n`);
      }

      const read = vi.spyOn(statsIo, "readFile");
      const first = await h.json<UsageStats>("/api/stats?range=all");
      expect(read).toHaveBeenCalledTimes(2);

      read.mockClear();
      const second = await h.json<UsageStats>("/api/stats?range=all");
      expect(second.body).toEqual(first.body);
      expect(read).not.toHaveBeenCalled();

      // A different range reuses the per-file parses instead of reading them again.
      const week = await h.json<UsageStats>("/api/stats?range=7d");
      expect(week.body.range).toBe("7d");
      expect(read).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
      await h.close();
    }
  });

  it("defaults to all and rejects an unknown range", async () => {
    const h = await createSettingsHarness();
    try {
      const empty = await h.json<UsageStats>("/api/stats");
      expect(empty.body).toMatchObject({
        range: "all",
        sessions: 0,
        messages: 0,
        tokens: 0,
        activeDays: 0,
        peakHour: null,
        topModel: null,
      });
      expect(empty.body.daily).toHaveLength(182);

      const invalid = await h.json("/api/stats?range=90d");
      expect(invalid.status).toBe(400);
    } finally {
      await h.close();
    }
  });
});
