import type { SessionStatus } from "../types";

export function projectBadge(...statuses: Array<SessionStatus | undefined>): SessionStatus {
  const ranks: SessionStatus[] = ["error", "running", "waiting", "exited", "idle"];
  for (const status of ranks) {
    if (statuses.some((item) => item === status)) return status;
  }
  return "idle";
}

export function statusDotClass(status: SessionStatus | undefined) {
  if (status === "running") return "bg-emerald-500";
  if (status === "waiting") return "bg-sky-400";
  if (status === "error") return "bg-red-500";
  return "bg-zinc-600";
}

export function statusDotExtra(status: SessionStatus | undefined) {
  if (status === "running") return "status-running";
  return "";
}

export function sessionKindLabel(kind: "agent" | "runner") {
  return kind === "agent" ? "Agent" : "运行终端";
}
