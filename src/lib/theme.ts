import type { AppTheme } from "../types";

export const xtermThemes = {
  dark: {
    background: "#282828",
    foreground: "#ebdbb2",
    cursor: "#ebdbb2",
    selectionBackground: "#504945",
    black: "#282828",
    red: "#cc241d",
    green: "#98971a",
    yellow: "#d79921",
    blue: "#458588",
    magenta: "#b16286",
    cyan: "#689d6a",
    white: "#a89984",
    brightBlack: "#928374",
    brightRed: "#fb4934",
    brightGreen: "#b8bb26",
    brightYellow: "#fabd2f",
    brightBlue: "#83a598",
    brightMagenta: "#d3869b",
    brightCyan: "#8ec07c",
    brightWhite: "#ebdbb2",
  },
  light: {
    background: "#f5f1ec",
    foreground: "#54433a",
    cursor: "#54433a",
    selectionBackground: "#d9d3ce",
    black: "#e9e1db",
    red: "#c77b8b",
    green: "#6e9b72",
    yellow: "#bc5c00",
    blue: "#7892bd",
    magenta: "#be79bb",
    cyan: "#739797",
    white: "#7d6658",
    brightBlack: "#a98a78",
    brightRed: "#bf0021",
    brightGreen: "#3a684a",
    brightYellow: "#a06d00",
    brightBlue: "#465aa4",
    brightMagenta: "#904180",
    brightCyan: "#3d6568",
    brightWhite: "#54433a",
  },
} as const;

export type XtermTheme = (typeof xtermThemes)[AppTheme];

export function hexToOscRgb(hex: string) {
  const h = hex.replace("#", "");
  const r = h.slice(0, 2);
  const g = h.slice(2, 4);
  const b = h.slice(4, 6);
  return `rgb:${r}${r}/${g}${g}/${b}${b}`;
}

export function normalizeTheme(theme: string | undefined): AppTheme {
  return theme === "light" ? "light" : "dark";
}

export function applyDocumentTheme(theme: string | undefined) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
}
