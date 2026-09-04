export type FsClipMode = "copy" | "cut";

export type FsClipboard = {
  mode: FsClipMode;
  path: string;
  name: string;
  isDir: boolean;
};

type Listener = (clip: FsClipboard | null) => void;

let current: FsClipboard | null = null;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener(current);
}

export function getFsClipboard() {
  return current;
}

export function setFsClipboard(next: FsClipboard | null) {
  current = next;
  emit();
}

export function clearFsClipboard() {
  if (!current) return;
  current = null;
  emit();
}

export function subscribeFsClipboard(listener: Listener) {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}
