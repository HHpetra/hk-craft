import type { SessionKind } from "../types";
import { isSessionKind } from "./paneCaps";

export { isSessionKind } from "./paneCaps";

export function cn(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(" ");
}

export function formatAgentInject(path: string, prefix: string) {
  return `${prefix}"${path}" `;
}

export function formatRunnerInject(path: string) {
  return `"${path}" `;
}

export function formatSize(bytes: number, isDir: boolean) {
  if (isDir) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export function formatTime(epochSeconds: number) {
  if (!epochSeconds) return "—";
  return new Date(epochSeconds * 1000).toLocaleString();
}

export type ParsedSessionId = {
  projectId: string;
  kind: SessionKind;
  paneId: string;
};

export function sessionId(projectId: string, kind: SessionKind, paneId: string) {
  return `${projectId}:${kind}:${paneId}`;
}

export function parseSessionId(id: string): ParsedSessionId | null {
  const [projectId, kind, ...rest] = id.split(":");
  const paneId = rest.join(":");
  if (!projectId || !paneId || !isSessionKind(kind)) return null;
  return { projectId, kind, paneId };
}

export function normalizeFsPath(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "");
}

export function pathsEqual(a: string, b: string) {
  return normalizeFsPath(a).toLowerCase() === normalizeFsPath(b).toLowerCase();
}

export function isPathWithin(root: string, current: string) {
  const r = normalizeFsPath(root).toLowerCase();
  const c = normalizeFsPath(current).toLowerCase();
  return c === r || c.startsWith(`${r}/`);
}

export function breadcrumbParts(root: string, current: string, rootLabel: string) {
  const sep = current.includes("\\") ? "\\" : "/";
  const r = normalizeFsPath(root);
  const c = normalizeFsPath(current);
  const parts = [{ label: rootLabel, path: root }];
  if (pathsEqual(root, current)) return parts;
  if (!isPathWithin(root, current)) {
    return [{ label: current, path: current }];
  }
  const rel = c.slice(r.length).replace(/^\//, "");
  let acc = r;
  for (const seg of rel.split("/").filter(Boolean)) {
    acc += `/${seg}`;
    parts.push({ label: seg, path: acc.split("/").join(sep) });
  }
  return parts;
}
