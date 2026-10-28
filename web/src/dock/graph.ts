/**
 * Lane layout for the commit graph in the Git tab. Commits come in topological
 * order (children before parents); each row records which lane the commit sits
 * in and the line segments drawn above and below its dot. Lanes keep their
 * index while they live, so a passing branch is a straight vertical line.
 */

export interface GraphCommit {
  hash: string;
  parents?: string[];
}

/** A segment from lane `from` (at the row's top or middle) to lane `to`. */
export type Edge = [from: number, to: number];

export interface GraphRow {
  /** lane of the commit's dot */
  lane: number;
  /** segments from the row's top edge down to the dot's height */
  top: Edge[];
  /** segments from the dot's height down to the row's bottom edge */
  bottom: Edge[];
}

export interface GraphLayout {
  rows: GraphRow[];
  /** widest lane count over all rows */
  lanes: number;
}

export function layoutGraph(commits: GraphCommit[]): GraphLayout {
  // Each lane holds the hash it is waiting for (the next commit to land in it).
  const lanes: (string | null)[] = [];
  let width = 0;

  const rows = commits.map((commit): GraphRow => {
    const top: Edge[] = [];
    let lane = lanes.indexOf(commit.hash);
    lanes.forEach((waiting, index) => {
      if (waiting === null) return;
      // Every lane waiting for this commit converges into its dot.
      top.push(waiting === commit.hash ? [index, lane] : [index, index]);
    });
    if (lane === -1) lane = take(lanes, commit.hash); // a branch tip: nothing above
    for (let index = 0; index < lanes.length; index++) {
      if (index !== lane && lanes[index] === commit.hash) lanes[index] = null;
    }

    const [first, ...merged] = commit.parents ?? [];
    lanes[lane] = first ?? null;
    const bottom: Edge[] = [];
    const opened = new Set<number>();
    for (const parent of merged) {
      let target = lanes.indexOf(parent);
      if (target === -1) {
        target = take(lanes, parent);
        opened.add(target);
      }
      bottom.push([lane, target]);
    }
    lanes.forEach((waiting, index) => {
      if (waiting !== null && !opened.has(index)) bottom.push([index, index]);
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    width = Math.max(width, lane + 1, lanes.length, ...top.map(([from]) => from + 1));
    return { lane, top, bottom };
  });

  return { rows, lanes: width };
}

/** First free lane (or a new one), now waiting for `hash`. */
function take(lanes: (string | null)[], hash: string): number {
  const free = lanes.indexOf(null);
  const index = free === -1 ? lanes.length : free;
  lanes[index] = hash;
  return index;
}
