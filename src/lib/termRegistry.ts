import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import { ptyResize, ptyWrite, clipboardReadText } from "./api";
import { attachImeAnchor } from "./imeAnchor";
import { parseSessionId } from "./format";
import { hexToOscRgb, normalizeTheme, xtermThemes, type XtermTheme } from "./theme";
import type { PtyOutput } from "../types";

type RegistryEntry = {
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  osc: IDisposable[];
  composing: boolean;
  imeDetach?: () => void;
  fitted?: boolean;
};

type CoreViewport = {
  _renderService?: { dimensions?: { css?: { cell?: { width: number; height: number } } } };
  viewport?: { scrollBarWidth?: number };
};

const BUNDLED_NERD_FONT = "CaskaydiaCove Nerd Font Mono";

const LOCAL_NERD_CANDIDATES = [
  "Maple Mono NF CN",
  "Maple Mono NF",
  "CaskaydiaCove Nerd Font Mono",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaCove NF",
  "Cascadia Code NF",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono Nerd Font",
  "JetBrainsMono NF",
  "MesloLGS NF",
  "FiraCode Nerd Font Mono",
  "FiraCode Nerd Font",
  "Hack Nerd Font Mono",
  "Hack Nerd Font",
  "Sarasa Term SC Nerd",
  "Sarasa Term SC Nerd Font",
];

let preferredTerminalFont = "";
let queriedLocalNerdFonts: string[] = [];

function fontAvailable(family: string) {
  try {
    return document.fonts.check(`12px "${family}"`);
  } catch {
    return false;
  }
}

function isNerdFamily(name: string) {
  const n = name.toLowerCase();
  return n.includes("nerd") || /\bnf\b/.test(n) || n.includes("caskaydia") || n.includes("meslolgs") || n.includes("powerline");
}

function dropWeightVariants(names: string[]) {
  const set = new Set(names);
  return names.filter((name) => {
    const base = name.replace(
      /\s+(ExtraBold|ExtraLight|SemiBold|Light|Medium|Thin|Bold|Black|Retina)$/i,
      "",
    );
    return base === name || !set.has(base);
  });
}

function uniqueFonts(names: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const key = name.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(name.trim());
  }
  return out;
}

export function listDetectedNerdFonts() {
  const fromQuery = queriedLocalNerdFonts.filter(isNerdFamily);
  const fromCheck = LOCAL_NERD_CANDIDATES.filter(
    (name) => name !== BUNDLED_NERD_FONT && fontAvailable(name),
  );
  return dropWeightVariants(
    uniqueFonts([...fromQuery, ...fromCheck, ...LOCAL_NERD_CANDIDATES.filter((name) => name !== BUNDLED_NERD_FONT)]),
  );
}

export async function discoverLocalNerdFonts() {
  await Promise.all(
    LOCAL_NERD_CANDIDATES.map((name) => document.fonts.load(`12px "${name}"`).catch(() => undefined)),
  );
  const query = (window as Window & { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts;
  if (query) {
    try {
      const fonts = await query();
      queriedLocalNerdFonts = uniqueFonts(fonts.map((font) => font.family).filter(isNerdFamily));
    } catch {
      queriedLocalNerdFonts = [];
    }
  }
  return listDetectedNerdFonts();
}

export function setPreferredTerminalFont(family: string | undefined) {
  preferredTerminalFont = family?.trim() ?? "";
}

export function terminalFontFamily(preferred = preferredTerminalFont) {
  const want = preferred.trim().toLowerCase() === "auto" ? "" : preferred.trim();
  const nerd = dropWeightVariants(
    uniqueFonts([
      ...(want ? [want] : []),
      ...queriedLocalNerdFonts.filter(isNerdFamily),
      ...LOCAL_NERD_CANDIDATES.filter((name) => name !== BUNDLED_NERD_FONT),
      BUNDLED_NERD_FONT,
    ]),
  );
  return [
    ...nerd.map((family) => `"${family}"`),
    "Cascadia Code",
    "Cascadia Mono",
    "Consolas",
    '"Microsoft YaHei Mono"',
    '"Microsoft YaHei"',
    "monospace",
  ].join(", ");
}

export function applyRegisteredTerminalFont(preferred?: string) {
  if (preferred !== undefined) setPreferredTerminalFont(preferred);
  const family = terminalFontFamily();
  for (const entry of registry.values()) {
    entry.term.options.fontFamily = family;
    refreshWhenFontsReady(entry.term);
  }
}

function refreshWhenFontsReady(term: Terminal) {
  const primary = terminalFontFamily().split(",")[0]?.replace(/"/g, "").trim() ?? BUNDLED_NERD_FONT;
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

const registry = new Map<string, RegistryEntry>();
const generations = new Map<string, number>();
const pending = new Map<string, string[]>();
const closedSessions = new Set<string>();
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
  for (const chunk of chunks) term.write(chunk);
}

type FittedSize = { cols: number; rows: number };
type SessionKindKey = "agent" | "runner";

const lastFittedByKind = new Map<SessionKindKey, FittedSize>();

function sessionKind(sessionId: string): SessionKindKey {
  return parseSessionId(sessionId)?.kind === "runner" ? "runner" : "agent";
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

export function hydrateLastFittedSizes(sizes: {
  agent?: number[] | FittedSize | null;
  runner?: number[] | FittedSize | null;
}) {
  const agent = parseFittedSize(sizes.agent);
  if (agent) lastFittedByKind.set("agent", agent);
  const runner = parseFittedSize(sizes.runner);
  if (runner) lastFittedByKind.set("runner", runner);
}

export function peekLastFittedSizes(): { agent?: [number, number]; runner?: [number, number] } {
  const agent = lastFittedByKind.get("agent");
  const runner = lastFittedByKind.get("runner");
  return {
    ...(agent ? { agent: [agent.cols, agent.rows] as [number, number] } : {}),
    ...(runner ? { runner: [runner.cols, runner.rows] as [number, number] } : {}),
  };
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

export function ensurePtyOutputListener(): Promise<void> {
  if (outputListenPromise) return outputListenPromise;
  outputListenPromise = listen<PtyOutput>("pty-output", (event) => {
    const { session_id, data, generation } = event.payload;
    if (!isCurrentGeneration(session_id, generation ?? 0)) return;
    const entry = registry.get(session_id);
    if (entry) {
      entry.term.write(data);
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

function buildTerminal(sessionId: string): RegistryEntry {
  ensurePtyOutputListener();
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

function bindTerminalInput(entry: RegistryEntry) {
  const { term } = entry;
  term.attachCustomKeyEventHandler((event) => {
    if (!isPasteShortcut(event)) return true;
    event.preventDefault();
    void readClipboardText().then((text) => {
      if (text) term.paste(text);
    });
    return false;
  });

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
  const availW = entry.host.clientWidth - scrollbar;
  const availH = entry.host.clientHeight;
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
  const timer = fitTimers.get(sessionId);
  if (timer !== undefined) {
    window.clearTimeout(timer);
    fitTimers.delete(sessionId);
  }
  const entry = registry.get(sessionId);
  if (!entry) return;
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
