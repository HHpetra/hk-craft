export const DEFAULT_EXPLORER_COLUMNS = [42, 28, 16, 14] as const;
export const MIN_EXPLORER_COLUMN = 8;
export const MIN_EXPLORER_COLUMN_PX = 64;
export const EXPLORER_COLUMN_COUNT = 4;

export type ExplorerColumnWidths = [number, number, number, number];

function isFinitePositive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

export function normalizeColumnWidths(input?: readonly number[] | null): ExplorerColumnWidths {
  if (!input || input.length !== EXPLORER_COLUMN_COUNT || !input.every(isFinitePositive)) {
    return [...DEFAULT_EXPLORER_COLUMNS];
  }
  const min = MIN_EXPLORER_COLUMN;
  const weights = input.map((value) => Math.max(value, min));
  const extraTotal = weights.reduce((total, value) => total + (value - min), 0);
  const leftover = 100 - min * EXPLORER_COLUMN_COUNT;
  if (extraTotal <= 0) {
    const even = 100 / EXPLORER_COLUMN_COUNT;
    return [even, even, even, even];
  }
  return weights.map((value) => min + (leftover * (value - min)) / extraTotal) as ExplorerColumnWidths;
}

export function minColumnPct(
  tableWidth: number,
  minPct: number = MIN_EXPLORER_COLUMN,
  minPx: number = MIN_EXPLORER_COLUMN_PX,
): number {
  if (!(tableWidth > 0) || !(minPx > 0)) return minPct;
  const fromPx = (minPx / tableWidth) * 100;
  const cap = 100 / EXPLORER_COLUMN_COUNT;
  return Math.min(cap, Math.max(minPct, fromPx));
}

export function resizeAdjacent(
  widths: readonly number[],
  index: number,
  deltaPct: number,
  minPct: number = MIN_EXPLORER_COLUMN,
): ExplorerColumnWidths {
  const next = normalizeColumnWidths(widths);
  if (!Number.isFinite(deltaPct) || index < 0 || index >= next.length - 1) {
    return next;
  }
  const left = next[index];
  const right = next[index + 1];
  if (left + right < minPct * 2) return next;
  const delta = Math.min(right - minPct, Math.max(minPct - left, deltaPct));
  next[index] = left + delta;
  next[index + 1] = right - delta;
  return next;
}
