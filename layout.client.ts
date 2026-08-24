/**
 * Lane assignment for the commit graph.
 *
 * Pure data in, pure data out: every commit gets a lane (column) and every row lists the line
 * segments that cross it, so the renderer never has to look at neighbouring rows.
 *
 * Lanes are never compacted. A lane keeps its index until the commit it waits for arrives, which
 * means a "through" segment is always a straight vertical line and a freed index can be reused by
 * a later branch tip.
 */

export interface LayoutCommit {
  readonly hash: string;
  readonly parents: readonly string[];
}

export type SegmentKind = "through" | "in" | "out";

export interface GraphSegment {
  /** Lane the segment starts at (top edge of the row). */
  readonly from: number;
  /** Lane the segment ends at (bottom edge of the row). */
  readonly to: number;
  readonly colorIndex: number;
  readonly kind: SegmentKind;
}

export interface GraphRow {
  /** Lane holding the commit dot. */
  readonly lane: number;
  readonly colorIndex: number;
  readonly isMerge: boolean;
  readonly segments: readonly GraphSegment[];
}

export interface GraphLayout {
  readonly rows: GraphRow[];
  /** Widest lane index used anywhere, plus one. Drives the graph column width. */
  readonly laneCount: number;
}

interface Lane {
  /** Commit this lane is waiting for. */
  hash: string;
  colorIndex: number;
}

export const GRAPH_COLOR_COUNT = 8;

/** Lowest index a new lane can occupy. Equal to `lanes.length` when every slot is taken. */
function freeLane(lanes: (Lane | null)[]): number {
  const free = lanes.indexOf(null);
  return free === -1 ? lanes.length : free;
}

function claimLane(lanes: (Lane | null)[], lane: Lane): number {
  const index = freeLane(lanes);
  lanes[index] = lane;
  return index;
}

export function layoutCommits(commits: readonly LayoutCommit[]): GraphLayout {
  const lanes: (Lane | null)[] = [];
  const rows: GraphRow[] = [];
  let laneCount = 0;
  let nextColor = 0;

  for (const commit of commits) {
    const waiting: number[] = [];
    for (let index = 0; index < lanes.length; index += 1) {
      if (lanes[index]?.hash === commit.hash) waiting.push(index);
    }

    let lane: number;
    let colorIndex: number;
    if (waiting.length === 0) {
      // A branch tip: nothing points here yet. Reserve a lane without occupying it, so the top
      // half of this row stays empty — no line is drawn above a tip.
      colorIndex = nextColor % GRAPH_COLOR_COUNT;
      nextColor += 1;
      lane = freeLane(lanes);
    } else {
      lane = waiting[0]!;
      colorIndex = lanes[lane]!.colorIndex;
    }

    const segments: GraphSegment[] = [];

    // Top half: lanes that already existed above this row.
    for (let index = 0; index < lanes.length; index += 1) {
      const active = lanes[index];
      if (!active) continue;
      if (waiting.includes(index)) {
        segments.push({ from: index, to: lane, colorIndex: active.colorIndex, kind: "in" });
      } else {
        segments.push({ from: index, to: index, colorIndex: active.colorIndex, kind: "through" });
      }
    }

    // Everything that pointed at this commit is now consumed.
    for (const index of waiting) lanes[index] = null;
    lanes[lane] = null;

    // Bottom half: one segment per parent.
    commit.parents.forEach((parent, parentIndex) => {
      if (parentIndex === 0) {
        lanes[lane] = { hash: parent, colorIndex };
        segments.push({ from: lane, to: lane, colorIndex, kind: "out" });
        return;
      }
      const existing = lanes.findIndex((active) => active?.hash === parent);
      if (existing !== -1) {
        segments.push({
          from: lane,
          to: existing,
          colorIndex: lanes[existing]!.colorIndex,
          kind: "out",
        });
        return;
      }
      const mergeColor = nextColor % GRAPH_COLOR_COUNT;
      nextColor += 1;
      const target = claimLane(lanes, { hash: parent, colorIndex: mergeColor });
      segments.push({ from: lane, to: target, colorIndex: mergeColor, kind: "out" });
    });

    for (const segment of segments) {
      laneCount = Math.max(laneCount, segment.from + 1, segment.to + 1);
    }
    laneCount = Math.max(laneCount, lane + 1);

    rows.push({ lane, colorIndex, isMerge: commit.parents.length > 1, segments });
  }

  return { rows, laneCount };
}
