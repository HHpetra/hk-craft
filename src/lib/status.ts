import type { SessionKind, SessionStatus } from "../types";
import { paneCaps } from "./paneCaps";

export function projectBadge(...statuses: Array<SessionStatus | undefined>): SessionStatus {
  const ranks: SessionStatus[] = ["error", "running", "waiting", "exited", "idle"];
  for (const status of ranks) {
    if (statuses.some((item) => item === status)) return status;
  }
  return "idle";
}

export function statusDotClass(status: SessionStatus | undefined) {
  if (status === "running") return "bg-(--color-success)";
  if (status === "waiting") return "bg-(--color-warning)";
  if (status === "error") return "bg-(--color-danger)";
  return "bg-(--color-ink-subtle)";
}

export function statusRowClass(status: SessionStatus | undefined, active = false) {
  if (active) {
    if (status === "running") return "bg-(--color-success)/25";
    if (status === "waiting") return "bg-(--color-warning)/25";
    if (status === "error") return "bg-(--color-danger)/25";
    return "bg-active";
  }
  if (status === "running") return "bg-(--color-success)/15";
  if (status === "waiting") return "bg-(--color-warning)/15";
  if (status === "error") return "bg-(--color-danger)/15";
  return "";
}

export function sessionKindLabel(kind: SessionKind) {
  return paneCaps(kind).label;
}
