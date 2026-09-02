export type DropPlace = "before" | "after";

export type DropLine = { id: string; place: DropPlace };

export const DRAG_THRESHOLD = 6;

export function insertSlot(
  root: HTMLElement,
  selector: string,
  client: number,
  axis: "x" | "y",
): number {
  const items = [...root.querySelectorAll<HTMLElement>(selector)];
  if (items.length === 0) return 0;
  for (let i = 0; i < items.length; i++) {
    const rect = items[i].getBoundingClientRect();
    const mid = axis === "x" ? rect.left + rect.width / 2 : rect.top + rect.height / 2;
    if (client < mid) return i;
  }
  return items.length;
}

export function finalIndex(slot: number, fromIndex: number): number {
  if (fromIndex < 0) return slot;
  return slot > fromIndex ? slot - 1 : slot;
}

export function lineForSlot(ids: string[], slot: number, fromIndex: number): DropLine | null {
  if (ids.length === 0) return null;
  if (fromIndex >= 0 && finalIndex(slot, fromIndex) === fromIndex) return null;
  if (slot <= 0) return { id: ids[0], place: "before" };
  if (slot >= ids.length) return { id: ids[ids.length - 1], place: "after" };
  return { id: ids[slot], place: "before" };
}
