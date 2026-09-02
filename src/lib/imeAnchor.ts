import type { Terminal } from "@xterm/xterm";

/**
 * Ink-style Agent TUIs (cursor-agent, Claude Code, OpenCode, …) draw a
 * visual caret as a single inverse-video cell, then park the hardware
 * cursor after the last paint — usually behind the prompt dialog.
 * xterm's CompositionHelper follows the hardware cursor, so Windows IME
 * candidates appear behind the dialog instead of in the input box.
 */
export function attachImeAnchor(term: Terminal) {
  const root = term.element;
  const textarea = term.textarea;
  const screen = root?.querySelector<HTMLElement>(".xterm-screen");
  const composition = root?.querySelector<HTMLElement>(".composition-view");
  if (!root || !textarea || !screen || !composition) {
    return () => undefined;
  }
  const ime = textarea;
  const screenEl = screen;
  const preedit = composition;

  let composing = false;
  let pinned: { left: string; top: string } | null = null;

  function cellSize() {
    const rect = screenEl.getBoundingClientRect();
    return {
      width: rect.width / Math.max(term.cols, 1),
      height: rect.height / Math.max(term.rows, 1),
    };
  }

  function findVisualCaret(): { col: number; row: number } | null {
    const buf = term.buffer.active;
    const startY = buf.viewportY;
    for (let y = startY + term.rows - 1; y >= startY; y--) {
      const line = buf.getLine(y);
      if (!line) continue;
      for (let x = line.length - 1; x >= 0; x--) {
        const cell = line.getCell(x);
        if (!cell?.isInverse()) continue;
        const left = x > 0 ? line.getCell(x - 1) : null;
        const right = x + 1 < line.length ? line.getCell(x + 1) : null;
        if (left?.isInverse() && right?.isInverse()) continue;
        return { col: x, row: y - startY };
      }
    }
    return null;
  }

  function caretCell() {
    const visual = findVisualCaret();
    if (visual) return visual;
    const buf = term.buffer.active;
    return {
      col: Math.min(Math.max(0, buf.cursorX), Math.max(0, term.cols - 1)),
      row: Math.min(Math.max(0, buf.cursorY), Math.max(0, term.rows - 1)),
    };
  }

  function applyPin(left: string, top: string) {
    ime.style.setProperty("left", left, "important");
    ime.style.setProperty("top", top, "important");
    preedit.style.setProperty("left", left, "important");
    preedit.style.setProperty("top", top, "important");
  }

  function styleCaret() {
    const { width, height } = cellSize();
    if (width < 1 || height < 1) return;
    ime.style.width = `${width}px`;
    ime.style.height = `${height}px`;
    ime.style.lineHeight = `${height}px`;
    ime.style.fontSize = `${term.options.fontSize ?? 13}px`;
    ime.style.fontFamily = String(term.options.fontFamily ?? "");
    ime.style.zIndex = "20";
    ime.style.opacity = "0.01";
    ime.style.color = "transparent";
    ime.style.caretColor = "transparent";
    ime.style.background = "transparent";
    ime.style.pointerEvents = "none";
    preedit.style.height = `${height}px`;
    preedit.style.lineHeight = `${height}px`;
  }

  function pinToCaret(useVisual: boolean) {
    const hit = useVisual ? findVisualCaret() : caretCell();
    if (!hit) return false;
    const { width, height } = cellSize();
    if (width < 1 || height < 1) return false;
    const left = `${Math.round(hit.col * width)}px`;
    const top = `${Math.round(hit.row * height)}px`;
    if (pinned && pinned.left === left && pinned.top === top) {
      styleCaret();
      return true;
    }
    pinned = { left, top };
    styleCaret();
    applyPin(left, top);
    return true;
  }

  function followCaret() {
    if (composing) {
      if (!pinToCaret(true) && !pinned) pinToCaret(false);
      return;
    }
    pinToCaret(true) || pinToCaret(false);
  }

  function reapply(el: HTMLElement) {
    if (!composing || !pinned) return;
    if (el.style.left !== pinned.left || el.style.top !== pinned.top) {
      applyPin(pinned.left, pinned.top);
    }
  }

  const moTa = new MutationObserver(() => reapply(ime));
  const moCv = new MutationObserver(() => reapply(preedit));

  function onCompositionStart() {
    composing = true;
    followCaret();
  }

  function onCompositionEnd() {
    composing = false;
    followCaret();
  }

  ime.addEventListener("compositionstart", onCompositionStart, true);
  ime.addEventListener("compositionend", onCompositionEnd, true);
  moTa.observe(ime, { attributes: true, attributeFilter: ["style"] });
  moCv.observe(preedit, { attributes: true, attributeFilter: ["style"] });
  const renderSub = term.onRender(followCaret);
  followCaret();

  return () => {
    composing = false;
    pinned = null;
    renderSub.dispose();
    ime.removeEventListener("compositionstart", onCompositionStart, true);
    ime.removeEventListener("compositionend", onCompositionEnd, true);
    moTa.disconnect();
    moCv.disconnect();
  };
}
