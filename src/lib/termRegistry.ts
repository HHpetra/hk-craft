import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { listen } from "@tauri-apps/api/event";
import { ptyResize, ptyWrite } from "./api";
import { hexToOscRgb, normalizeTheme, xtermThemes, type XtermTheme } from "./theme";
import type { PtyOutput } from "../types";

type RegistryEntry = {
  sessionId: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  osc: IDisposable[];
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

export function isCurrentGeneration(sessionId: string, generation: number) {
  const current = generations.get(sessionId);
  if (current === undefined || generation === 0) return true;
  return generation === current;
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

export function getOrCreateTerminal(sessionId: string): RegistryEntry {
  ensurePtyOutputListener();
  closedSessions.delete(sessionId);
  const existing = registry.get(sessionId);
  if (existing) return existing;

  const theme = xtermThemes[normalizeTheme(document.documentElement.dataset.theme)];
  const term = new Terminal({
    cursorBlink: true,
    fontSize: 13,
    fontFamily: terminalFontFamily(),
    theme,
    scrollback: 5000,
    allowProposedApi: true,
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
  term.open(host);
  refreshWhenFontsReady(term);

  term.onData((data) => {
    void ptyWrite(sessionId, data).catch(() => undefined);
  });

  const entry: RegistryEntry = { sessionId, term, fit, host, osc };
  registry.set(sessionId, entry);
  flushPending(sessionId, term);
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

export function fitAndResize(sessionId: string, entry: RegistryEntry) {
  const dims = entry.fit.proposeDimensions();
  if (!dims || dims.cols < 2 || dims.rows < 2) return;
  entry.fit.fit();
  void ptyResize(sessionId, entry.term.cols, entry.term.rows).catch(() => undefined);
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
  const entry = registry.get(sessionId);
  if (!entry) return;
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
