import { describe, expect, it } from "vitest";
import { relativeTime } from "./time.ts";

// Local-time construction keeps the assertions timezone-independent; the dates
// sit away from any DST transition so hour arithmetic is stable.
const at = (...parts: [number, number, number, number?, number?, number?]) =>
  new Date(parts[0], parts[1] - 1, parts[2], parts[3] ?? 12, parts[4] ?? 0, parts[5] ?? 0);
const now = at(2025, 2, 10).getTime();

describe("relativeTime", () => {
  it("shows 刚刚 under a minute and for future or invalid input", () => {
    expect(relativeTime(at(2025, 2, 10, 11, 59, 30).toISOString(), now)).toBe("刚刚");
    expect(relativeTime(at(2025, 2, 10, 12, 30).toISOString(), now)).toBe("刚刚");
    expect(relativeTime("not a date", now)).toBe("");
    expect(relativeTime("", now)).toBe("");
  });

  it("counts minutes, hours and days", () => {
    expect(relativeTime(at(2025, 2, 10, 11, 59, 0).toISOString(), now)).toBe("1分钟");
    expect(relativeTime(at(2025, 2, 10, 11, 58).toISOString(), now)).toBe("2分钟");
    expect(relativeTime(at(2025, 2, 10, 10, 0).toISOString(), now)).toBe("2小时");
    expect(relativeTime(at(2025, 2, 8, 12, 0).toISOString(), now)).toBe("2天");
    expect(relativeTime(at(2025, 2, 4, 12, 0).toISOString(), now)).toBe("6天");
  });

  it("falls back to a date this year and then a full date", () => {
    expect(relativeTime(at(2025, 2, 1, 12, 0).toISOString(), now)).toBe("2月1日");
    expect(relativeTime(at(2025, 1, 5, 12, 0).toISOString(), now)).toBe("1月5日");
    expect(relativeTime(at(2024, 12, 31, 12, 0).toISOString(), now)).toBe("2024/12/31");
  });
});
