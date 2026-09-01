import { useEffect, useState } from "react";
import { ptyWrite } from "./api";
import { formatAgentInject, formatRunnerInject, sessionId } from "./format";
import type { SessionKind } from "../types";
import { useWorkspace } from "../store/workspace";

type DragListener = (paths: string[] | null) => void;

let current: string[] | null = null;
let hoverKind: SessionKind | null = null;
let lastInjectKey = "";
let lastInjectAt = 0;
const listeners = new Set<DragListener>();

function emit() {
  for (const listener of listeners) listener(current);
}

function isSessionKind(value: string | null | undefined): value is SessionKind {
  return value === "agent" || value === "runner";
}

export function beginPathDrag(paths: string[]) {
  const next = paths.map((p) => p.trim()).filter(Boolean);
  current = next.length ? next : null;
  hoverKind = null;
  emit();
}

export function endPathDrag() {
  hoverKind = null;
  if (!current) return;
  current = null;
  emit();
}

export function peekPathDrag(): string[] | null {
  return current;
}

export function noteDropHover(kind: SessionKind | null) {
  hoverKind = kind;
}

export function kindAtPoint(x: number, y: number): SessionKind | null {
  const el = document.elementFromPoint(x, y);
  const kind = el?.closest("[data-drop-kind]")?.getAttribute("data-drop-kind");
  return isSessionKind(kind) ? kind : null;
}

function prefixForProject(projectId: string) {
  const state = useWorkspace.getState();
  const project = state.config?.projects.find((p) => p.id === projectId);
  const preset = state.config?.agent_presets.find((p) => p.id === project?.agent_preset);
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

export function injectDroppedPaths(
  projectId: string,
  kind: SessionKind,
  paths: string[],
  prefix: string,
) {
  if (!projectId || !paths.length) return;
  const key = `${projectId}:${kind}:${paths.join("\0")}`;
  const now = Date.now();
  if (key === lastInjectKey && now - lastInjectAt < 400) return;
  lastInjectKey = key;
  lastInjectAt = now;
  const text = paths
    .map((path) =>
      kind === "agent" ? formatAgentInject(path, prefix) : formatRunnerInject(path),
    )
    .join("");
  void ptyWrite(sessionId(projectId, kind), text).catch((err) => {
    useWorkspace.getState().setNotice(String(err));
  });
}

export function commitPathDrop(kind?: SessionKind | null) {
  const paths = peekPathDrag();
  if (!paths?.length) {
    endPathDrag();
    return;
  }
  const target = isSessionKind(kind) ? kind : hoverKind;
  const projectId = useWorkspace.getState().activeProjectId;
  if (!target || !projectId) {
    endPathDrag();
    return;
  }
  injectDroppedPaths(projectId, target, paths, prefixForProject(projectId));
  endPathDrag();
}

export function usePathDropListeners() {
  useEffect(() => {
    const onDragOver = (event: DragEvent) => {
      if (!peekPathDrag()?.length) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      noteDropHover(kindAtPoint(event.clientX, event.clientY));
    };
    const onDrop = (event: DragEvent) => {
      if (!peekPathDrag()?.length) return;
      event.preventDefault();
      commitPathDrop(kindAtPoint(event.clientX, event.clientY));
    };
    const onDragEnd = (event: DragEvent) => {
      if (!peekPathDrag()?.length) return;
      commitPathDrop(kindAtPoint(event.clientX, event.clientY));
    };
    const onPointerUp = () => {
      if (!peekPathDrag()?.length || !hoverKind) return;
      const kind = hoverKind;
      window.setTimeout(() => {
        if (peekPathDrag()?.length) commitPathDrop(kind);
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
