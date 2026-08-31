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

export function sessionId(projectId: string, kind: "agent" | "runner") {
  return `${projectId}:${kind}`;
}

export function breadcrumbParts(root: string, current: string, rootLabel: string) {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const sep = current.includes("\\") ? "\\" : "/";
  const r = norm(root);
  const c = norm(current);
  const parts = [{ label: rootLabel, path: root }];
  if (c.toLowerCase() === r.toLowerCase()) return parts;
  if (!c.toLowerCase().startsWith(r.toLowerCase())) {
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
