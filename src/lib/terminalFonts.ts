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
  const fromCheck = LOCAL_NERD_CANDIDATES.filter(fontAvailable);
  return dropWeightVariants(uniqueFonts([...fromQuery, ...fromCheck, ...LOCAL_NERD_CANDIDATES]));
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
      ...LOCAL_NERD_CANDIDATES,
    ]),
  );
  return [
    ...nerd.map((family) => `"${family}"`),
    "Cascadia Code",
    "Cascadia Mono",
    "Consolas",
    '"Sarasa Term SC"',
    '"Noto Sans Mono CJK SC"',
    '"Microsoft YaHei Mono"',
    "monospace",
  ].join(", ");
}

export function primaryTerminalFont() {
  return terminalFontFamily().split(",")[0]?.replace(/"/g, "").trim() ?? "monospace";
}
