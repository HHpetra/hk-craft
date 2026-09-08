import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { ptySessionStats } from "../../lib/api";
import { formatSize } from "../../lib/format";
import { formatCpuPct, groupSessionStats, totalSessionStats } from "../../lib/sessionStats";
import type { PtySessionStat } from "../../types";
import { useWorkspace } from "../../store/workspace";

type SessionStatsOverlayProps = {
  open: boolean;
  onClose: () => void;
};

export function SessionStatsOverlay({ open, onClose }: SessionStatsOverlayProps) {
  const config = useWorkspace((s) => s.config);
  const openedProjectIds = useWorkspace((s) => s.openedProjectIds);
  const setNotice = useWorkspace((s) => s.setNotice);
  const [stats, setStats] = useState<PtySessionStat[] | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    void ptySessionStats()
      .then(setStats)
      .catch((err) => setNotice(String(err)))
      .finally(() => setLoading(false));
  }, [setNotice]);

  useEffect(() => {
    if (!open) {
      setStats(null);
      return;
    }
    load();
  }, [open, load]);

  if (!open || !config) return null;

  const groups = stats ? groupSessionStats(stats, config.projects, openedProjectIds, config.agent_presets) : [];
  const totals = totalSessionStats(groups);
  const hasDocker = groups.some((group) => group.rows.some((row) => row.docker));
  const empty = !loading && stats !== null && groups.length === 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="max-h-[85vh] w-[640px] max-w-[90vw] overflow-auto rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-[13px] font-semibold text-ink">终端占用</h3>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-ink-subtle hover:bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        {empty && <div className="text-[12px] text-ink-subtle">当前没有运行中的终端</div>}

        {loading && stats === null && <div className="text-[12px] text-ink-subtle">采集中…</div>}

        {groups.map((group) => (
          <section key={group.projectId} className="mb-4">
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
              <span className="truncate text-[11px] font-medium uppercase tracking-wider text-ink-subtle">
                {group.projectName}
              </span>
              <span className="shrink-0 text-[11px] text-ink-muted">
                {formatSize(group.memoryBytes, false)} · {formatCpuPct(group.cpuPct)}
              </span>
            </div>
            <div className="space-y-0.5">
              {group.rows.map((row) => (
                <div
                  key={row.sessionId}
                  className="grid grid-cols-[1fr_auto_auto_auto] items-center gap-3 rounded bg-field px-2 py-1.5 text-[12px] text-ink"
                >
                  <span className="truncate">{row.title}</span>
                  <span className="tabular-nums text-ink-muted">{formatSize(row.memoryBytes, false)}</span>
                  <span className="tabular-nums text-ink-muted">{formatCpuPct(row.cpuPct)}</span>
                  <span className="tabular-nums text-ink-subtle">{row.processCount} 进程</span>
                </div>
              ))}
            </div>
          </section>
        ))}

        {hasDocker && (
          <p className="mb-3 text-[11px] text-ink-subtle">Docker 行为宿主机 docker exec 占用，不含容器内部。</p>
        )}

        <div className="mt-2 flex items-center justify-between border-t border-line pt-3">
          <div className="text-[11px] text-ink-muted">
            {stats !== null && !empty
              ? `合计 ${formatSize(totals.memoryBytes, false)} · ${formatCpuPct(totals.cpuPct)} · ${totals.sessions} 个终端`
              : "\u00a0"}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink disabled:opacity-50"
              onClick={load}
              disabled={loading}
            >
              {loading ? "采集中…" : "刷新"}
            </button>
            <button
              type="button"
              className="rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90"
              onClick={onClose}
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
