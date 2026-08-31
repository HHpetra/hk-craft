import { useEffect, useState } from "react";
import { FolderOpen, X } from "lucide-react";
import { pickDirectory } from "../../lib/dialog";
import { useWorkspace } from "../../store/workspace";

export function ProjectDialog() {
  const open = useWorkspace((s) => s.projectDialogOpen);
  const setOpen = useWorkspace((s) => s.setProjectDialogOpen);
  const presets = useWorkspace((s) => s.config?.agent_presets ?? []);
  const addProject = useWorkspace((s) => s.addProject);
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [preset, setPreset] = useState(presets[0]?.id ?? "cursor-agent");

  useEffect(() => {
    if (!open) return;
    setName("");
    setPath("");
    const list = useWorkspace.getState().config?.agent_presets ?? [];
    setPreset(list[0]?.id ?? "cursor-agent");
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <form
        className="w-[480px] max-w-[90vw] rounded-lg border border-line bg-surface-elevated p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (!path.trim()) return;
          void addProject(name, path, preset);
        }}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink">新建项目</h2>
          <button type="button" onClick={() => setOpen(false)} className="text-ink-subtle hover:text-ink">
            <X size={16} />
          </button>
        </div>
        <label className="mb-3 block">
          <div className="mb-1 text-xs text-ink-subtle">名称</div>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md bg-field px-2 py-1.5 text-ink outline-none"
            placeholder="Agent10-WorkTable"
          />
        </label>
        <label className="mb-3 block">
          <div className="mb-1 text-xs text-ink-subtle">路径</div>
          <div className="flex gap-2">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              className="w-full rounded-md bg-field px-2 py-1.5 text-ink outline-none"
              placeholder="C:\\Projects\\my-app"
              required
            />
            <button
              type="button"
              className="shrink-0 rounded-md bg-field px-2 text-ink hover:bg-hover"
              title="选择目录"
              onClick={() => {
                void pickDirectory("选择项目目录").then((dir) => {
                  if (!dir) return;
                  setPath(dir);
                  if (!name.trim()) {
                    const parts = dir.replace(/\\/g, "/").split("/").filter(Boolean);
                    setName(parts[parts.length - 1] ?? "");
                  }
                });
              }}
            >
              <FolderOpen size={16} />
            </button>
          </div>
        </label>
        <label className="mb-5 block">
          <div className="mb-1 text-xs text-ink-subtle">Agent 预设</div>
          <select
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            className="w-full rounded-md bg-field px-2 py-1.5 text-ink outline-none"
          >
            {presets.map((item) => (
              <option key={item.id} value={item.id} className="bg-surface-elevated">
                {item.name}
              </option>
            ))}
          </select>
        </label>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-ink-muted hover:text-ink"
            onClick={() => setOpen(false)}
          >
            取消
          </button>
          <button type="submit" className="rounded-md bg-btn px-3 py-1.5 text-btn-fg hover:opacity-90">
            添加
          </button>
        </div>
      </form>
    </div>
  );
}
