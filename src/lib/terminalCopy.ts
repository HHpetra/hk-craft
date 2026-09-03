export type KeyChord = {
  type: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * Copy chords for a canvas terminal (no DOM selection, so the browser
 * "Copy image" menu is useless). Ctrl/Cmd+C copies only when text is
 * selected, otherwise the key must reach the PTY as interrupt.
 * Ctrl+Shift+C and Ctrl+Insert always copy.
 */
export function shouldCopySelection(event: KeyChord, hasSelection: boolean) {
  if (event.altKey) return false;
  const mod = event.ctrlKey || event.metaKey;
  if (event.code === "Insert" && mod && !event.shiftKey) return true;
  if (event.code !== "KeyC" || !mod) return false;
  return event.shiftKey || hasSelection;
}
