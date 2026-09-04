const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

export function isValidFileName(name: string) {
  if (!name || name !== name.trim()) return false;
  if (name === "." || name === "..") return false;
  if (INVALID_CHARS.test(name)) return false;
  return !name.endsWith(".") && !name.endsWith(" ");
}

function splitFileName(name: string): { stem: string; ext: string } {
  const idx = name.lastIndexOf(".");
  if (idx <= 0) return { stem: name, ext: "" };
  return { stem: name.slice(0, idx), ext: name.slice(idx) };
}

export function uniqueName(desired: string, existing: string[], isDir = false) {
  const lower = existing.map((item) => item.toLowerCase());
  if (!lower.includes(desired.toLowerCase())) return desired;
  const { stem, ext } = isDir ? { stem: desired, ext: "" } : splitFileName(desired);
  let index = 1;
  while (true) {
    const candidate = `${stem} (${index})${ext}`;
    if (!lower.includes(candidate.toLowerCase())) return candidate;
    index += 1;
  }
}

export function joinDir(dir: string, name: string) {
  const sep = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${sep}${name}`;
}

export function parentDir(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  if (idx <= 0) return normalized;
  if (normalized[idx - 1] === ":") return normalized.slice(0, idx + 1);
  return normalized.slice(0, idx);
}

export function fileName(path: string) {
  const normalized = path.replace(/[\\/]+$/, "");
  const idx = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}
