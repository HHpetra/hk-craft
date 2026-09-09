import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import { ptyResize, ptyWrite, clipboardReadText, clipboardWriteText } from "./api";
import { attachImeAnchor } from "./imeAnchor";
import { parseSessionId } from "./format";
import { SESSION_KINDS } from "./paneCaps";
import { shouldCopySelection } from "./terminalCopy";
import { clientToCell, hostMouseUpAction, isDragGesture, sgrClick, sgrMouse, wheelButton } from "./sgrMouse";
import { createMouseStripper } from "./stripMouseTracking";
import { hexToOscRgb, normalizeTheme, xtermThemes, type XtermTheme } from "./theme";
import { primaryTerminalFont, setPreferredTerminalFont, terminalFontFamily } from "./terminalFonts";
import type { PtyExit, PtyOutput, SessionKind } from "../types";

type RegistryEntry = {
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  osc: IDisposable[];
  composing: boolean;
  imeDetach?: () => void;
  copyDetach?: () => void;
  fitted?: boolean;
};

type CoreViewport = {
  _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
  viewport?: { scrollBarWidth?: number };
};

function bindOscColorQuery(sessionId: string, term: Terminal, theme: XtermTheme): IDisposable[] {
  const reply = (code: number, color: string) => {
    void ptyWrite(sessionId, `\x1b]${code};${hexToOscRgb(color)}\x1b\\`).catch(() => undefined);
  };
  const handle = (code: number, color: string) =>
    term.parser.registerOscHandler(code, (data) => {
      if (data === "?" || data.startsWith("?")) {
        reply(code, color);
      }
      return true;
    });
  return [handle(10, theme.foreground), handle(11, theme.background)];
}

function refreshWhenFontsReady(term: Terminal) {
  const primary = primaryTerminalFont();
  const redraw = () => {
    try {
      term.refresh(0, Math.max(0, term.rows - 1));
    } catch {
      // terminal not opened yet
    }
  };
  void document.fonts.load(`13px "${primary}"`).then(redraw);
  void document.fonts.ready.then(redraw);
}

const registry = new Map<string, RegistryEntry>();
const generations = new Map<string, number>();
const pending = new Map<string, string[]>();
const closedSessions = new Set<string>();
const copyOnSelectSessions = new Set<string>();
const mouseStrippers = new Map<string, (chunk: string) => string>();
const MAX_PENDING_CHARS = 256_000;

let outputListenPromise: Promise<void> | null = null;

function pendingSize(sessionId: string) {
  return (pending.get(sessionId) ?? []).reduce((n, chunk) => n + chunk.length, 0);
}

function bufferOutput(sessionId: string, data: string) {
  const chunks = pending.get(sessionId) ?? [];
  chunks.push(data);
  pending.set(sessionId, chunks);
  let extra = pendingSize(sessionId) - MAX_PENDING_CHARS;
  while (extra > 0 && chunks.length > 0) {
    const first = chunks[0];
    if (first.length <= extra) {
      extra -= first.length;
      chunks.shift();
    } else {
      chunks[0] = first.slice(extra);
      extra = 0;
    }
  }
}

function flushPending(sessionId: string, term: Terminal) {
  const chunks = pending.get(sessionId);
  if (!chunks?.length) return;
  pending.delete(sessionId);
  for (const chunk of chunks) writeTermOutput(sessionId, term, chunk);
}

export function setSessionCopyOnSelect(sessionId: string, on: boolean) {
  if (on) {
    copyOnSelectSessions.add(sessionId);
    return;
  }
  copyOnSelectSessions.delete(sessionId);
  mouseStrippers.delete(sessionId);
}

function stripForSession(sessionId: string, data: string) {
  let strip = mouseStrippers.get(sessionId);
  if (!strip) {
    strip = createMouseStripper();
    mouseStrippers.set(sessionId, strip);
  }
  return strip(data);
}

function writeTermOutput(sessionId: string, term: Terminal, data: string) {
  const chunk = copyOnSelectSessions.has(sessionId) ? stripForSession(sessionId, data) : data;
  if (chunk) term.write(chunk);
}

type FittedSize = { cols: number; rows: number };

const lastFittedByKind = new Map<SessionKind, FittedSize>();
const outputWatchers = new Set<(sessionId: string, data: string, generation: number) => void>();
const exitWatchers = new Set<(sessionId: string, generation: number) => void>();

function sessionKind(sessionId: string): SessionKind {
  return parseSessionId(sessionId)?.kind ?? "agent";
}

function rememberFittedSize(sessionId: string, cols: number, rows: number) {
  if (cols < 2 || rows < 2) return;
  lastFittedByKind.set(sessionKind(sessionId), { cols, rows });
}

function parseFittedSize(value: number[] | FittedSize | null | undefined): FittedSize | null {
  if (!value) return null;
  const cols = Array.isArray(value) ? value[0] : value.cols;
  const rows = Array.isArray(value) ? value[1] : value.rows;
  if (typeof cols !== "number" || typeof rows !== "number" || cols < 2 || rows < 2) return null;
  return { cols, rows };
}

export function lastFittedSize(sessionId: string): FittedSize | null {
  return lastFittedByKind.get(sessionKind(sessionId)) ?? null;
}

export function hydrateLastFittedSizes(sizes: Partial<Record<SessionKind, number[] | FittedSize | null>>) {
  for (const kind of SESSION_KINDS) {
    const parsed = parseFittedSize(sizes[kind]);
    if (parsed) lastFittedByKind.set(kind, parsed);
  }
}

export function peekLastFittedSizes(): Partial<Record<SessionKind, [number, number]>> {
  const out: Partial<Record<SessionKind, [number, number]>> = {};
  for (const kind of SESSION_KINDS) {
    const size = lastFittedByKind.get(kind);
    if (size) out[kind] = [size.cols, size.rows];
  }
  return out;
}

export function isCurrentGeneration(sessionId: string, generation: number) {
  const current = generations.get(sessionId);
  if (current === undefined || generation === 0) return true;
  if (generation < current) return false;
  if (generation > current) generations.set(sessionId, generation);
  return true;
}

export function setSessionGeneration(sessionId: string, generation: number) {
  generations.set(sessionId, generation);
}

export function subscribePtyOutput(
  listener: (sessionId: string, data: string, generation: number) => void,
): () => void {
  outputWatchers.add(listener);
  return () => {
    outputWatchers.delete(listener);
  };
}

export function subscribePtyExit(listener: (sessionId: string, generation: number) => void): () => void {
  exitWatchers.add(listener);
  return () => {
    exitWatchers.delete(listener);
  };
}

function notifyPtyOutput(sessionId: string, data: string, generation: number) {
  for (const listener of outputWatchers) listener(sessionId, data, generation);
}

function notifyPtyExit(sessionId: string, generation: number) {
  for (const listener of exitWatchers) listener(sessionId, generation);
}

export function ensurePtyOutputListener(): Promise<void> {
  if (outputListenPromise) return outputListenPromise;
  outputListenPromise = listen<PtyOutput>("pty-output", (event) => {
    const { session_id, data, generation } = event.payload;
    if (!isCurrentGeneration(session_id, generation ?? 0)) return;
    notifyPtyOutput(session_id, data, generation ?? 0);
    const entry = registry.get(session_id);
    if (entry) {
      writeTermOutput(session_id, entry.term, data);
    } else if (!closedSessions.has(session_id)) {
      bufferOutput(session_id, data);
    }
  })
    .then(() => undefined)
    .catch((err) => {
      outputListenPromise = null;
      throw err;
    });
  return outputListenPromise;
}

let exitListenPromise: Promise<void> | null = null;

export function ensurePtyExitListener(): Promise<void> {
  if (exitListenPromise) return exitListenPromise;
  exitListenPromise = listen<PtyExit>("pty-exit", (event) => {
    const { session_id, generation } = event.payload;
    if (!isCurrentGeneration(session_id, generation ?? 0)) return;
    notifyPtyExit(session_id, generation ?? 0);
  })
    .then(() => undefined)
    .catch((err) => {
      exitListenPromise = null;
      throw err;
    });
  return exitListenPromise;
}

export function ensurePtyListeners() {
  return Promise.all([ensurePtyOutputListener(), ensurePtyExitListener()]).then(() => undefined);
}

function buildTerminal(sessionId: string): RegistryEntry {
  void ensurePtyListeners();
  const theme = xtermThemes[normalizeTheme(document.documentElement.dataset.theme)];
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: terminalFontFamily(),
    theme,
    scrollback: 5000,
    windowsMode: navigator.userAgent.includes("Windows"),
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // canvas renderer fallback
  }

  const host = document.createElement("div");
  host.style.width = "100%";
  host.style.height = "100%";
  host.style.padding = "8px";
  host.style.boxSizing = "border-box";
  host.style.overflow = "hidden";
  const osc = bindOscColorQuery(sessionId, term, theme);
  term.onData((data) => {
    void ptyWrite(sessionId, data).catch(() => undefined);
  });

  return { sessionId, term, fit, host, osc, composing: false };
}

function isPasteShortcut(event: KeyboardEvent) {
  if (event.type !== "keydown" || event.altKey) return false;
  if (event.code === "Insert" && event.shiftKey && !event.ctrlKey && !event.metaKey) {
    return true;
  }
  return event.code === "KeyV" && (event.ctrlKey || event.metaKey);
}

/** Ctrl/Shift+Enter should insert LF. xterm maps every Enter to CR. */
function isNewlineShortcut(event: KeyboardEvent) {
  if (event.altKey || event.metaKey) return false;
  if (event.key !== "Enter") return false;
  return event.ctrlKey || event.shiftKey;
}

async function readClipboardText() {
  try {
    const text = await navigator.clipboard.readText();
    if (text) return text;
  } catch {
    // WebView often denies clipboard-read without an extra permission
  }
  try {
    return await clipboardReadText();
  } catch {
    return "";
  }
}

async function writeClipboardText(text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // WebView often denies clipboard-write without an extra permission
  }
  try {
    await clipboardWriteText(text);
  } catch {
    // keep the selection; user can retry
  }
}

function copyTerminalSelection(term: Terminal, clear: boolean) {
  const text = term.getSelection();
  if (!text) return;
  void writeClipboardText(text).then(() => {
    if (clear) term.clearSelection();
  });
}

function eventCell(term: Terminal, clientX: number, clientY: number) {
  const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
  const rect = screen?.getBoundingClientRect();
  if (!rect) return null;
  return clientToCell(clientX, clientY, rect, term.cols, term.rows);
}

function bindTerminalInput(entry: RegistryEntry) {
  const { term, host } = entry;
  term.attachCustomKeyEventHandler((event) => {
    if (isPasteShortcut(event)) {
      event.preventDefault();
      void readClipboardText().then((text) => {
        if (text) term.paste(text);
      });
      return false;
    }
    if (shouldCopySelection(event, term.hasSelection())) {
      if (event.type === "keydown") {
        event.preventDefault();
        copyTerminalSelection(term, false);
      }
      return false;
    }
    if (isNewlineShortcut(event)) {
      if (entry.composing) return true;
      if (event.type === "keydown") {
        event.preventDefault();
        term.input("\n");
      }
      return false;
    }
    return true;
  });

  const onContextMenu = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (term.hasSelection()) copyTerminalSelection(term, true);
  };

  let press: { x: number; y: number } | null = null;
  const onMouseUp = (event: MouseEvent) => {
    window.removeEventListener("mouseup", onMouseUp);
    if (!copyOnSelectSessions.has(entry.sessionId)) {
      press = null;
      return;
    }
    const start = press;
    press = null;
    if (!start) return;
    const startCell = eventCell(term, start.x, start.y);
    const endCell = eventCell(term, event.clientX, event.clientY);
    const action = hostMouseUpAction({
      button: event.button,
      dragged: isDragGesture({
        startX: start.x,
        startY: start.y,
        endX: event.clientX,
        endY: event.clientY,
        startCell,
        endCell,
      }),
      shiftKey: event.shiftKey,
      hasSelection: term.hasSelection(),
    });
    if (action === "copy") {
      copyTerminalSelection(term, false);
      return;
    }
    if (action === "click" && startCell) {
      term.clearSelection();
      void ptyWrite(entry.sessionId, sgrClick(startCell.col, startCell.row)).catch(() => undefined);
    }
  };
  const onMouseDown = (event: MouseEvent) => {
    if (!copyOnSelectSessions.has(entry.sessionId)) return;
    if (event.button !== 0) return;
    press = { x: event.clientX, y: event.clientY };
    window.removeEventListener("mouseup", onMouseUp);
    window.addEventListener("mouseup", onMouseUp);
  };

  host.addEventListener("contextmenu", onContextMenu, true);
  host.addEventListener("mousedown", onMouseDown);
  term.attachCustomWheelEventHandler((event) => {
    if (!copyOnSelectSessions.has(entry.sessionId)) return true;
    const button = wheelButton(event.deltaX, event.deltaY);
    const cell = eventCell(term, event.clientX, event.clientY);
    if (button == null || !cell) return false;
    event.preventDefault();
    void ptyWrite(entry.sessionId, sgrMouse(button, cell.col, cell.row)).catch(() => undefined);
    return false;
  });
  entry.copyDetach = () => {
    host.removeEventListener("contextmenu", onContextMenu, true);
    host.removeEventListener("mousedown", onMouseDown);
    window.removeEventListener("mouseup", onMouseUp);
    press = null;
  };

  const textarea = term.textarea;
  if (!textarea) return;

  entry.imeDetach = attachImeAnchor(term);

  const onStart = () => {
    entry.composing = true;
  };
  const onEnd = () => {
    entry.composing = false;
    scheduleFitAndResize(entry.sessionId, entry);
  };
  textarea.addEventListener("compositionstart", onStart);
  textarea.addEventListener("compositionend", onEnd);
  textarea.addEventListener(
    "paste",
    (event) => {
      const fromEvent = event.clipboardData?.getData("text/plain") ?? "";
      if (fromEvent) return;
      event.preventDefault();
      event.stopPropagation();
      void readClipboardText().then((text) => {
        if (text) term.paste(text);
      });
    },
    true,
  );
}

function openAndRegister(entry: RegistryEntry) {
  entry.term.open(entry.host);
  bindTerminalInput(entry);
  refreshWhenFontsReady(entry.term);
  registry.set(entry.sessionId, entry);
  flushPending(entry.sessionId, entry.term);
}

export function getOrCreateTerminal(sessionId: string): RegistryEntry {
  closedSessions.delete(sessionId);
  const existing = registry.get(sessionId);
  if (existing) return existing;
  const entry = buildTerminal(sessionId);
  openAndRegister(entry);
  return entry;
}

export function applyRegisteredTerminalFont(preferred?: string) {
  if (preferred !== undefined) setPreferredTerminalFont(preferred);
  const family = terminalFontFamily();
  for (const entry of registry.values()) {
    entry.term.options.fontFamily = family;
    refreshWhenFontsReady(entry.term);
  }
}

export function applyRegisteredXtermTheme(theme: string) {
  const next = xtermThemes[normalizeTheme(theme)];
  for (const entry of registry.values()) {
    entry.term.options.theme = next;
    for (const d of entry.osc) d.dispose();
    entry.osc = bindOscColorQuery(entry.sessionId, entry.term, next);
  }
}

const fitTimers = new Map<string, number>();

export function scheduleFitAndResize(sessionId: string, entry: RegistryEntry, delayMs = 50) {
  const prev = fitTimers.get(sessionId);
  if (prev !== undefined) window.clearTimeout(prev);
  fitTimers.set(
    sessionId,
    window.setTimeout(() => {
      fitTimers.delete(sessionId);
      fitAndResize(sessionId, entry);
    }, delayMs),
  );
}

export function fitAndResize(sessionId: string, entry: RegistryEntry) {
  if (entry.composing) return;
  const dims = proposePaneDimensions(entry);
  if (!dims || dims.cols < 2 || dims.rows < 2) return;
  entry.fitted = true;
  // only a real size change may reach the pty: a rows-growth makes ConPTY
  // repaint the whole viewport as an erase-line+CRLF flood
  if (dims.cols === entry.term.cols && dims.rows === entry.term.rows) {
    rememberFittedSize(sessionId, dims.cols, dims.rows);
    return;
  }
  entry.term.resize(dims.cols, dims.rows);
  rememberFittedSize(sessionId, entry.term.cols, entry.term.rows);
  void ptyResize(sessionId, entry.term.cols, entry.term.rows).catch(() => undefined);
}

function proposePaneDimensions(entry: RegistryEntry) {
  const core = (entry.term as unknown as { _core?: CoreViewport })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  if (!cell?.width || !cell?.height) return entry.fit.proposeDimensions();
  const scrollbar =
    entry.term.options.scrollback === 0 ? 0 : (core?.viewport?.scrollBarWidth ?? 0);
  const style = getComputedStyle(entry.host);
  const padX = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  const padY = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
  const availW = entry.host.clientWidth - scrollbar - padX;
  const availH = entry.host.clientHeight - padY;
  if (availW < 16 || availH < 16) return undefined;
  return {
    cols: Math.max(2, Math.floor(availW / cell.width)),
    rows: Math.max(2, Math.floor(availH / cell.height)),
  };
}

// The pane size a session should be spawned with; null until the pane has
// completed its first fit, so callers can wait for a real measurement.
export function terminalSize(sessionId: string) {
  const entry = registry.get(sessionId);
  if (!entry?.fitted) return null;
  return { cols: entry.term.cols, rows: entry.term.rows };
}

export function waitTerminalSize(sessionId: string, timeoutMs = 800) {
  return new Promise<{ cols: number; rows: number } | null>((resolve) => {
    const started = Date.now();
    const tick = () => {
      const size = terminalSize(sessionId);
      if (size || Date.now() - started >= timeoutMs) {
        resolve(size);
        return;
      }
      setTimeout(tick, 50);
    };
    tick();
  });
}

export function clearTerminal(sessionId: string) {
  pending.delete(sessionId);
  const entry = registry.get(sessionId);
  entry?.term.clear();
  entry?.term.reset();
}

export function disposeTerminal(sessionId: string) {
  closedSessions.add(sessionId);
  pending.delete(sessionId);
  generations.delete(sessionId);
  setSessionCopyOnSelect(sessionId, false);
  const timer = fitTimers.get(sessionId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    fitTimers.delete(sessionId);
  }
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.copyDetach?.();
  entry.imeDetach?.();
  registry.delete(sessionId);
  for (const d of entry.osc) {
    try {
      d.dispose();
    } catch {
      // already disposed
    }
  }
  try {
    entry.term.dispose();
  } catch {
    // already disposed
  }
  entry.host.remove();
}

export type { RegistryEntry };
