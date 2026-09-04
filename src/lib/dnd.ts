import { useEffect, useState } from "react";
import { ptyWrite } from "./api";
import { formatAgentInject, formatRunnerInject, parseSessionId } from "./format";
import { paneCaps } from "./paneCaps";
import { useWorkspace } from "../store/workspace";

type DragListener = (paths: string[] | null) => void;

let current: string[] | null = null;
let hoverSessionId: string | null = null;
let lastInjectKey = "";
let lastInjectAt = 0;
const listeners = new Set<DragListener>();

function emit() {
  for (const listener of listeners) listener(current);
}

export function beginPathDrag(paths: string[]) {
  const next = paths.map((p) => p.trim()).filter(Boolean);
  current = next.length ? next : null;
  hoverSessionId = null;
  emit();
}

export function endPathDrag() {
  hoverSessionId = null;
  if (!current) return;
  current = null;
  emit();
}

export function peekPathDrag(): string[] | null {
  return current;
}

function injectableSession(session: string | null | undefined): string | null {
  if (!session) return null;
  const parsed = parseSessionId(session);
  if (!parsed || !paneCaps(parsed.kind).acceptsPathDrop) return null;
  return session;
}

export function noteDropHover(session: string | null) {
  hoverSessionId = injectableSession(session);
}

export function sessionAtPoint(x: number, y: number): string | null {
  const el = document.elementFromPoint(x, y);
  const id = el?.closest("[data-drop-session]")?.getAttribute("data-drop-session");
  return injectableSession(id);
}

function prefixForSession(session: string) {
  const parsed = parseSessionId(session);
  const state = useWorkspace.getState();
  if (!parsed) return "@";
  const project = state.config?.projects.find((p) => p.id === parsed.projectId);
  const pane = project?.panes.find((item) => item.id === parsed.paneId);
  const presetId = pane?.kind === "agent" ? (pane.preset_id ?? project?.agent_preset) : project?.agent_preset;
  const preset = state.config?.agent_presets.find((p) => p.id === presetId);
  return preset?.drag_prefix ?? "@";
}

export function subscribePathDrag(listener: DragListener) {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

export function usePathDrag() {
  const [paths, setPaths] = useState<string[] | null>(current);
  useEffect(() => subscribePathDrag(setPaths), []);
  return paths;
}

export function injectDroppedPaths(session: string, paths: string[], prefix?: string) {
  const parsed = parseSessionId(session);
  if (!parsed || !paneCaps(parsed.kind).acceptsPathDrop || !paths.length) return;
  const key = `${session}:${paths.join("\0")}`;
  const now = Date.now();
  if (key === lastInjectKey && now - lastInjectAt < 400) return;
  lastInjectKey = key;
  lastInjectAt = now;
  const dragPrefix = prefix ?? prefixForSession(session);
  const text = paths
    .map((path) =>
      parsed.kind === "agent" ? formatAgentInject(path, dragPrefix) : formatRunnerInject(path),
    )
    .join("");
  void ptyWrite(session, text).catch((err) => {
    useWorkspace.getState().setNotice(String(err));
  });
}

export function commitPathDrop(session?: string | null) {
  const paths = peekPathDrag();
  if (!paths?.length) {
    endPathDrag();
    return;
  }
  const target = injectableSession(session) ?? hoverSessionId;
  if (!target) {
    endPathDrag();
    return;
  }
  injectDroppedPaths(target, paths, prefixForSession(target));
  endPathDrag();
}

export function usePathDropListeners() {
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!peekPathDrag()?.length) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      noteDropHover(sessionAtPoint(event.clientX, event.clientY));
    };
    const onDrop = (event: DragEvent) => {
      if (!peekPathDrag()?.length) return;
      event.preventDefault();
      commitPathDrop(sessionAtPoint(event.clientX, event.clientY));
    };
    const onDragEnd = (event: DragEvent) => {
      if (!peekPathDrag()?.length) return;
      commitPathDrop(sessionAtPoint(event.clientX, event.clientY));
    };
    const onPointerUp = () => {
      if (!peekPathDrag()?.length || !hoverSessionId) return;
      const session = hoverSessionId;
      window.setTimeout(() => {
        if (peekPathDrag()?.length) commitPathDrop(session);
      }, 0);
    };
    document.addEventListener("dragover", onDragOver, true);
    document.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", onDragEnd, true);
    window.addEventListener("pointerup", onPointerUp, true);
    return () => {
      document.removeEventListener("dragover", onDragOver, true);
      document.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", onDragEnd, true);
      window.removeEventListener("pointerup", onPointerUp, true);
    };
  }, []);
}
