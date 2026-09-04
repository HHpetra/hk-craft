import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { dockerListContainers } from "../../lib/api";
import { canSubmitDockerPane, resolveDockerSelection } from "../../lib/dockerSelect";
import { useWorkspace } from "../../store/workspace";
import type { DockerContainer, DockerPane } from "../../types";

function errorText(err: unknown) {
  if (typeof err === "string") return err;
  if (err instanceof Error) return err.message;
  return String(err);
}

export function DockerPaneDialog({
  open,
  onClose,
  pane,
}: {
  open: boolean;
  onClose: () => void;
  pane?: DockerPane | null;
}) {
  const addDockerPane = useWorkspace((s) => s.addDockerPane);
  const updateDockerPane = useWorkspace((s) => s.updateDockerPane);
  const [containers, setContainers] = useState<DockerContainer[]>([]);
  const [selected, setSelected] = useState("");
  const [autoExec, setAutoExec] = useState(false);
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = Boolean(pane);
  const listed = containers.some((item) => item.name === selected);
  const listFailed = Boolean(error);
  const hint =
    error ??
    (!loading && selected && !listed
      ? `找不到容器 ${selected}，请另选后再保存`
      : !loading && containers.length === 0
        ? "没有可用的容器"
        : null);
  const canConnect = canSubmitDockerPane({
    editing,
    loading,
    listed,
    listFailed,
    selected,
    original: pane?.docker_container?.trim() ?? "",
  });

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const prefer = pane?.docker_container?.trim() ?? "";
    setAutoExec(Boolean(pane?.docker_auto_exec));
    setCommand(pane?.docker_exec_command ?? "");
    setSelected(prefer);
    setError(null);
    setLoading(true);
    void dockerListContainers()
      .then((rows) => {
        if (cancelled) return;
        setContainers(rows);
        const choice = resolveDockerSelection(
          prefer,
          rows.map((item) => item.name),
        );
        setSelected(choice.selected);
      })
      .catch((err) => {
        if (cancelled) return;
        setContainers([]);
        setSelected(prefer);
        setError(errorText(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, pane]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <form
        className="w-[480px] max-w-[90vw] rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canConnect) return;
          if (pane) void updateDockerPane(pane.id, selected, autoExec, command);
          else void addDockerPane(selected, autoExec, command);
          onClose();
        }}
      >
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-ink">
            {editing ? "编辑 Docker 连接" : "连接 Docker 容器"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-0.5 text-ink-subtle hover:bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>
        <label className="mb-3.5 block">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">容器</div>
          <select
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            disabled={loading || containers.length === 0}
            className="w-full rounded-md bg-field px-2.5 py-1.5 text-[12px] text-ink outline-none disabled:opacity-50"
          >
            {selected && !listed && <option value={selected}>{selected}（未找到）</option>}
            {containers.length === 0 && !selected && <option value="">无容器</option>}
            {containers.map((item) => (
              <option key={`${item.id}:${item.name}`} value={item.name} className="bg-surface-elevated">
                {item.name}
                {item.status ? ` · ${item.status}` : ""}
              </option>
            ))}
          </select>
        </label>
        {hint && <p className="mb-3.5 text-[12px] text-red-400">{hint}</p>}
        <label className="mb-3.5 flex items-center gap-2 text-[12px] text-ink">
          <input
            type="checkbox"
            checked={autoExec}
            onChange={(event) => setAutoExec(event.target.checked)}
            className="rounded border-line"
          />
          重连时自动执行
        </label>
        <label className="mb-5 block">
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">命令</div>
          <textarea
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            disabled={!autoExec}
            rows={6}
            placeholder={"cd /workspace\ncursor-agent"}
            className="w-full resize-y rounded-md bg-field px-2.5 py-1.5 font-mono text-[12px] text-ink outline-none disabled:opacity-50"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink"
            onClick={onClose}
          >
            取消
          </button>
          <button
            type="submit"
            disabled={!canConnect}
            className="rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90 disabled:opacity-40"
          >
            {editing ? "保存" : "连接"}
          </button>
        </div>
      </form>
    </div>
  );
}
