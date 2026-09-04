export function resolveDockerSelection(
  prefer: string,
  names: string[],
): { selected: string; missing: boolean; empty: boolean } {
  const empty = names.length === 0;
  if (prefer) {
    return { selected: prefer, missing: !names.includes(prefer), empty };
  }
  return { selected: names[0] ?? "", missing: false, empty };
}

/** New panes need a listed container. Edit may still save auto-exec when `docker ps` itself failed. */
export function canSubmitDockerPane(input: {
  editing: boolean;
  loading: boolean;
  listed: boolean;
  listFailed: boolean;
  selected: string;
  original: string;
}): boolean {
  if (input.loading) return false;
  if (input.listed) return true;
  if (!input.editing || !input.listFailed) return false;
  const selected = input.selected.trim();
  return selected.length > 0 && selected === input.original.trim();
}
