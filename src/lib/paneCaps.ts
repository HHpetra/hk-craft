import type { PaneKind, SessionKind } from "../types";

export const SESSION_KINDS = ["agent", "runner", "docker"] as const;

export type PaneCaps = {
  terminal: boolean;
  acceptsPathDrop: boolean;
  quickCommands: boolean;
  contextEdit: "docker" | null;
  sizeBucket: SessionKind | null;
  label: string;
};

const PANE_CAPS: Record<PaneKind, PaneCaps> = {
  explorer: {
    terminal: false,
    acceptsPathDrop: false,
    quickCommands: false,
    contextEdit: null,
    sizeBucket: null,
    label: "资源管理",
  },
  agent: {
    terminal: true,
    acceptsPathDrop: true,
    quickCommands: false,
    contextEdit: null,
    sizeBucket: "agent",
    label: "Agent",
  },
  runner: {
    terminal: true,
    acceptsPathDrop: true,
    quickCommands: true,
    contextEdit: null,
    sizeBucket: "runner",
    label: "运行终端",
  },
  docker: {
    terminal: true,
    acceptsPathDrop: false,
    quickCommands: true,
    contextEdit: "docker",
    sizeBucket: "docker",
    label: "Docker",
  },
};

export function paneCaps(kind: PaneKind): PaneCaps {
  return PANE_CAPS[kind];
}

export function isSessionKind(kind: string): kind is SessionKind {
  return (SESSION_KINDS as readonly string[]).includes(kind);
}
