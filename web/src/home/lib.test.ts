import { describe, expect, it } from "vitest";
import { formatPeakHour, heatCuts, heatDays, heatLevel, modelLabel, weekday } from "./lib.ts";

describe("heatCuts / heatLevel", () => {
  it("has no cuts when every day is empty", () => {
    expect(heatCuts([0, 0])).toEqual([]);
    expect(heatLevel(0, [])).toBe(0);
    expect(heatLevel(100, [])).toBe(1);
  });

  it("cuts the non-zero values at the quartiles", () => {
    const cuts = heatCuts([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(cuts).toEqual([3, 5, 7]);
  });

  it("maps values to 0–4", () => {
    const cuts = heatCuts([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8].map((value) => heatLevel(value, cuts))).toEqual([
      0, 1, 1, 2, 2, 3, 3, 4, 4,
    ]);
  });

  it("never goes past level 4 for equal cuts", () => {
    expect(heatLevel(10, [10, 10, 10])).toBe(4);
  });
});

describe("formatPeakHour", () => {
  it("renders the two halves of the day", () => {
    expect(formatPeakHour(5)).toBe("上午 5 点");
    expect(formatPeakHour(15)).toBe("下午 3 点");
    expect(formatPeakHour(12)).toBe("中午 12 点");
    expect(formatPeakHour(0)).toBe("午夜 12 点");
    expect(formatPeakHour(21)).toBe("晚上 9 点");
  });

  it("shows a dash without data", () => {
    expect(formatPeakHour(null)).toBe("—");
    expect(formatPeakHour(undefined)).toBe("—");
  });
});

describe("modelLabel", () => {
  it("drops the provider prefix only", () => {
    expect(modelLabel("anthropic/claude-sonnet")).toBe("claude-sonnet");
    expect(modelLabel("openrouter/anthropic/claude")).toBe("anthropic/claude");
    expect(modelLabel("plain")).toBe("plain");
    expect(modelLabel(null)).toBe("—");
  });
});

describe("weekday", () => {
  it("returns Sunday-based day indexes", () => {
    expect(weekday("2025-10-26")).toBe(0); // Sunday
    expect(weekday("2025-10-27")).toBe(1);
    expect(weekday("2025-11-01")).toBe(6);
  });
});

describe("heatDays", () => {
  it("pads the newest week to Saturday", () => {
    const cells = heatDays([
      { date: "2025-10-29", tokens: 3 },
      { date: "2025-10-30", tokens: 5 },
    ]);
    expect(cells).toHaveLength(26 * 7);
    expect(cells[cells.length - 1]).toEqual({ date: "2025-11-01", tokens: 0, outside: true });
    expect(cells[cells.length - 3]).toEqual({ date: "2025-10-30", tokens: 5 });
  });

  it("shows 182 Sunday-starting days as 26 full columns", () => {
    const start = new Date(2025, 9, 26); // Sunday
    const daily = Array.from({ length: 182 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return { date: `${date.getFullYear()}-${month}-${day}`, tokens: index + 1 };
    });
    const cells = heatDays(daily);
    expect(cells).toHaveLength(26 * 7);
    expect(cells[0]).toEqual({ date: "2025-10-26", tokens: 1 });
    expect(cells.every((cell) => !cell.outside)).toBe(true);
  });

  it("keeps the newest 26 weeks when the window starts mid-week", () => {
    const start = new Date(2025, 3, 30); // Wednesday
    const daily = Array.from({ length: 182 }, (_, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      const month = String(date.getMonth() + 1).padStart(2, "0");
      const day = String(date.getDate()).padStart(2, "0");
      return { date: `${date.getFullYear()}-${month}-${day}`, tokens: index + 1 };
    });
    const cells = heatDays(daily);
    expect(cells).toHaveLength(26 * 7);
    expect(cells[0]).toEqual({ date: "2025-05-04", tokens: 5 });
    expect(cells[cells.length - 5]).toEqual({ date: "2025-10-28", tokens: 182 });
  });
});
