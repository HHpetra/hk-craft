export type ExplorerSelection = {
  selected: Set<string>;
  anchor: string | null;
};

export type ExplorerClickMods = {
  ctrl?: boolean;
  shift?: boolean;
};

export function emptySelection(): ExplorerSelection {
  return { selected: new Set(), anchor: null };
}

export function applyClick(
  state: ExplorerSelection,
  visible: readonly string[],
  path: string,
  mods: ExplorerClickMods = {},
): ExplorerSelection {
  if (mods.shift) {
    if (!state.anchor) {
      return { selected: new Set([path]), anchor: path };
    }
    const from = visible.indexOf(state.anchor);
    const to = visible.indexOf(path);
    if (from < 0 || to < 0) {
      return { selected: new Set([path]), anchor: path };
    }
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    return {
      selected: new Set(visible.slice(lo, hi + 1)),
      anchor: state.anchor,
    };
  }
  if (mods.ctrl) {
    const selected = new Set(state.selected);
    if (selected.has(path)) selected.delete(path);
    else selected.add(path);
    return { selected, anchor: path };
  }
  return { selected: new Set([path]), anchor: path };
}

export function applySelectAll(visible: readonly string[]): ExplorerSelection {
  if (!visible.length) return emptySelection();
  return { selected: new Set(visible), anchor: visible[0] };
}

export function applyContextSelect(state: ExplorerSelection, path: string): ExplorerSelection {
  if (state.selected.has(path)) return state;
  return { selected: new Set([path]), anchor: path };
}

export function applyClear(): ExplorerSelection {
  return emptySelection();
}
