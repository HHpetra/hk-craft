import type { AppTheme } from "../types";

export const xtermThemes = {
  dark: {
    background: "#0e0e10",
    foreground: "#e4e4e7",
    cursor: "#e4e4e7",
    selectionBackground: "#3f3f46",
  },
  light: {
    background: "#fafafa",
    foreground: "#18181b",
    cursor: "#18181b",
    selectionBackground: "#d4d4d8",
  },
} as const;

export function normalizeTheme(theme: string | undefined): AppTheme {
  return theme === "light" ? "light" : "dark";
}

export function applyDocumentTheme(theme: string | undefined) {
  document.documentElement.dataset.theme = normalizeTheme(theme);
}
