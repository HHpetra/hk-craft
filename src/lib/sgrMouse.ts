/** Pixel travel that turns a press into xterm selection instead of a TUI hit. */
export const DRAG_THRESHOLD_PX = 5;

export type CellPos = { col: number; row: number };

export type ScreenRect = {
  left: number;
  top: number;
  width: number;
  height: number;
};

export type HostMouseUpAction = "click" | "copy" | "none";

export function clampCell(col: number, row: number, cols: number, rows: number): CellPos {
  return {
    col: Math.min(Math.max(1, Math.trunc(col)), Math.max(1, cols)),
    row: Math.min(Math.max(1, Math.trunc(row)), Math.max(1, rows)),
  };
}

/** Map a client point onto 1-based SGR cells. Out-of-rect points clamp to the edge. */
export function clientToCell(
  clientX: number,
  clientY: number,
  rect: ScreenRect,
  cols: number,
  rows: number,
): CellPos | null {
  if (rect.width <= 0 || rect.height <= 0 || cols < 1 || rows < 1) return null;
  const col = Math.floor(((clientX - rect.left) / rect.width) * cols) + 1;
  const row = Math.floor(((clientY - rect.top) / rect.height) * rows) + 1;
  return clampCell(col, row, cols, rows);
}

export function isDragGesture(input: {
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  startCell?: CellPos | null;
  endCell?: CellPos | null;
  thresholdPx?: number;
}): boolean {
  const threshold = input.thresholdPx ?? DRAG_THRESHOLD_PX;
  if (Math.abs(input.endX - input.startX) >= threshold || Math.abs(input.endY - input.startY) >= threshold) {
    return true;
  }
  if (input.startCell && input.endCell) {
    return input.startCell.col !== input.endCell.col || input.startCell.row !== input.endCell.row;
  }
  return false;
}

/**
 * Left button: short press → TUI click; Shift or a drag → host selection.
 * Other buttons stay with the existing context-menu / paste path.
 */
export function hostMouseUpAction(input: {
  button: number;
  dragged: boolean;
  shiftKey: boolean;
  hasSelection: boolean;
}): HostMouseUpAction {
  if (input.button !== 0) return "none";
  if (input.shiftKey || input.dragged) return input.hasSelection ? "copy" : "none";
  return "click";
}

/** SGR 1006 press (`M`) or release (`m`). Buttons: 0 left, 64/65 wheel, 66/67 tilt. */
export function sgrMouse(button: number, col: number, row: number, release = false): string {
  return `\x1b[<${button};${col};${row}${release ? "m" : "M"}`;
}

export function sgrClick(col: number, row: number): string {
  return sgrMouse(0, col, row, false) + sgrMouse(0, col, row, true);
}

/** Dominant-axis wheel button, or null when the event is a no-op. */
export function wheelButton(deltaX: number, deltaY: number): number | null {
  if (deltaX === 0 && deltaY === 0) return null;
  if (Math.abs(deltaY) >= Math.abs(deltaX)) return deltaY < 0 ? 64 : 65;
  return deltaX < 0 ? 66 : 67;
}
