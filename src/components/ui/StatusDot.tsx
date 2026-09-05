import { cn } from "../../lib/format";
import { statusDotClass } from "../../lib/status";
import type { SessionStatus } from "../../types";

export function StatusDot({
  status,
  className,
}: {
  status: SessionStatus | undefined;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        statusDotClass(status),
        className,
      )}
    />
  );
}
