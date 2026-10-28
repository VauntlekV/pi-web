import { describe, expect, it } from "vitest";
import { layoutGraph } from "./graph.ts";

describe("layoutGraph", () => {
  it("keeps a linear history in one lane", () => {
    const { rows, lanes } = layoutGraph([
      { hash: "c", parents: ["b"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    expect(lanes).toBe(1);
    expect(rows).toEqual([
      { lane: 0, top: [], bottom: [[0, 0]] },
      { lane: 0, top: [[0, 0]], bottom: [[0, 0]] },
      { lane: 0, top: [[0, 0]], bottom: [] },
    ]);
  });

  it("opens a lane for a merge parent and converges at the fork point", () => {
    // m merges f into main; f and b both come from a.
    const { rows, lanes } = layoutGraph([
      { hash: "m", parents: ["b", "f"] },
      { hash: "f", parents: ["a"] },
      { hash: "b", parents: ["a"] },
      { hash: "a", parents: [] },
    ]);
    expect(lanes).toBe(2);
    expect(rows[0]).toEqual({ lane: 0, top: [], bottom: [[0, 1], [0, 0]] });
    expect(rows[1]).toEqual({ lane: 1, top: [[0, 0], [1, 1]], bottom: [[0, 0], [1, 1]] });
    expect(rows[2]).toEqual({ lane: 0, top: [[0, 0], [1, 1]], bottom: [[0, 0], [1, 1]] });
    expect(rows[3]).toEqual({ lane: 0, top: [[0, 0], [1, 0]], bottom: [] });
  });

  it("gives an unrelated branch tip its own lane and reuses freed lanes", () => {
    const { rows } = layoutGraph([
      { hash: "x", parents: ["a"] },
      { hash: "y", parents: ["a"] },
      { hash: "a", parents: [] },
      { hash: "z", parents: [] },
    ]);
    expect(rows.map((row) => row.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[3].top).toEqual([]);
  });
});
