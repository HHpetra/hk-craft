export type CaretCell = { col: number; row: number };

export type InverseCell = {
  inverse: boolean;
  /** 0 spacer, 1 narrow, 2 wide. */
  width: number;
};

export type CaretSearch = {
  lines: InverseCell[][];
  cursorCol: number;
  cursorRow: number;
};

const MAX_CARET_RUN = 2;

function runHeadCol(line: InverseCell[], start: number) {
  if (line[start]?.width === 0) return Math.max(0, start - 1);
  return start;
}

/** Isolated inverse runs (block / fullwidth caret), not status bars or selections. */
export function isolatedInverseCaret(search: CaretSearch): CaretCell | null {
  const hits: CaretCell[] = [];
  for (let row = 0; row < search.lines.length; row++) {
    const line = search.lines[row];
    let x = 0;
    while (x < line.length) {
      if (!line[x].inverse) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < line.length && line[x].inverse) x += 1;
      if (x - start <= MAX_CARET_RUN) {
        hits.push({ col: runHeadCol(line, start), row });
      }
    }
  }
  if (!hits.length) return null;
  let best = hits[0];
  let bestDist = Number.POSITIVE_INFINITY;
  for (const hit of hits) {
    const dist = Math.abs(hit.col - search.cursorCol) + Math.abs(hit.row - search.cursorRow);
    if (dist < bestDist) {
      best = hit;
      bestDist = dist;
    }
  }
  return best;
}

export function hardwareCaret(cursorCol: number, cursorRow: number, cols: number, rows: number): CaretCell {
  return {
    col: Math.min(Math.max(0, cursorCol), Math.max(0, cols - 1)),
    row: Math.min(Math.max(0, cursorRow), Math.max(0, rows - 1)),
  };
}
