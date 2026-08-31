import type { SessionStatus } from "../types";

export function projectBadge(
  agent: SessionStatus | undefined,
  runner: SessionStatus | undefined,
): SessionStatus {
  const ranks: SessionStatus[] = ["error", "running", "waiting", "exited", "idle"];
  for (const status of ranks) {
    if (agent === status || runner === status) return status;
  }
  return "idle";
}

export function statusDotClass(status: SessionStatus | undefined) {
  if (status === "running") return "bg-emerald-500";
  if (status === "waiting") return "bg-sky-500";
  if (status === "error") return "bg-red-500";
  return "bg-zinc-500";
}

export function sessionKindLabel(kind: "agent" | "runner") {
  return kind === "agent" ? "Agent" : "运行终端";
}
