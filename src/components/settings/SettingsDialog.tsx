import { useEffect, useState } from "react";
import { FolderOpen, Plus, Trash2, X } from "lucide-react";
import type { AgentPreset, Bookmark } from "../../types";
import { pickDirectory } from "../../lib/dialog";
import { normalizeTheme } from "../../lib/theme";
import { useWorkspace } from "../../store/workspace";

export function SettingsDialog() {
  const open = useWorkspace((s) => s.settingsOpen);
  const setOpen = useWorkspace((s) => s.setSettingsOpen);
  const config = useWorkspace((s) => s.config);
  const persist = useWorkspace((s) => s.persist);
  const setTheme = useWorkspace((s) => s.setTheme);
  const setNotice = useWorkspace((s) => s.setNotice);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [bookmarkName, setBookmarkName] = useState("");
  const [bookmarkPath, setBookmarkPath] = useState("");

  useEffect(() => {
    if (!open || !config) return;
    setPresets(config.agent_presets.map((p) => ({ ...p })));
    setBookmarks(config.bookmarks.map((b) => ({ ...b })));
  }, [open, config]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!open || !config) return null;

  const theme = normalizeTheme(config.settings.theme);

  function save() {
    const current = useWorkspace.getState().config;
    if (!current) return;
    if (presets.length === 0) {
      setNotice("至少保留一个 Agent 预设");
      return;
    }
    const fallback = presets[0].id;
    const projects = current.projects.map((project) =>
      presets.some((p) => p.id === project.agent_preset)
        ? project
        : { ...project, agent_preset: fallback },
    );
    void persist({
      ...current,
      agent_presets: presets,
      bookmarks,
      projects,
    });
    setOpen(false);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50">
      <div className="max-h-[85vh] w-[680px] max-w-[90vw] overflow-auto rounded-lg border border-line bg-surface-elevated p-4 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-sm font-medium text-ink">软件设置</h2>
          <button type="button" onClick={() => setOpen(false)} className="text-ink-subtle hover:text-ink">
            <X size={16} />
          </button>
        </div>

        <section className="mb-5">
          <div className="mb-2 text-xs text-ink-subtle">主题</div>
          <div className="flex gap-2">
            {(["dark", "light"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => void setTheme(value)}
                className={`rounded-md px-3 py-1.5 ${
                  theme === value ? "bg-btn text-btn-fg" : "bg-field text-ink hover:bg-hover"
                }`}
              >
                {value === "dark" ? "深色" : "浅色"}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between text-xs text-ink-subtle">
            <span>Agent 预设</span>
            <button
              type="button"
              className="flex items-center gap-1 text-ink-muted hover:text-ink"
              onClick={() =>
                setPresets([
                  ...presets,
                  {
                    id: crypto.randomUUID(),
                    name: "自定义",
                    command: "",
                    drag_prefix: "@",
                  },
                ])
              }
            >
              <Plus size={12} />
              新增
            </button>
          </div>
          <div className="max-h-48 space-y-2 overflow-auto">
            {presets.map((preset, index) => (
              <div key={preset.id} className="grid grid-cols-[1fr_1fr_72px_28px] gap-2">
                <input
                  value={preset.name}
                  onChange={(e) => {
                    const next = [...presets];
                    next[index] = { ...preset, name: e.target.value };
                    setPresets(next);
                  }}
                  className="rounded-md bg-field px-2 py-1 text-ink outline-none"
                />
                <input
                  value={preset.command}
                  onChange={(e) => {
                    const next = [...presets];
                    next[index] = { ...preset, command: e.target.value };
                    setPresets(next);
                  }}
                  className="rounded-md bg-field px-2 py-1 text-ink outline-none"
                />
                <input
                  value={preset.drag_prefix}
                  onChange={(e) => {
                    const next = [...presets];
                    next[index] = { ...preset, drag_prefix: e.target.value };
                    setPresets(next);
                  }}
                  className="rounded-md bg-field px-2 py-1 text-ink outline-none"
                />
                <button
                  type="button"
                  className="text-ink-subtle hover:text-red-500"
                  title="删除预设"
                  onClick={() => {
                    if (presets.length <= 1) {
                      setNotice("至少保留一个 Agent 预设");
                      return;
                    }
                    setPresets(presets.filter((p) => p.id !== preset.id));
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 text-xs text-ink-subtle">项目 Agent 绑定</div>
          <div className="space-y-2">
            {config.projects.length === 0 && (
              <div className="text-ink-subtle">暂无项目</div>
            )}
            {config.projects.map((project) => (
              <label key={project.id} className="flex items-center gap-2">
                <span className="w-40 truncate text-ink">{project.name}</span>
                <select
                  value={project.agent_preset}
                  onChange={(e) =>
                    void persist({
                      ...config,
                      projects: config.projects.map((p) =>
                        p.id === project.id ? { ...p, agent_preset: e.target.value } : p,
                      ),
                    })
                  }
                  className="flex-1 rounded-md bg-field px-2 py-1 text-ink outline-none"
                >
                  {presets.map((item) => (
                    <option key={item.id} value={item.id} className="bg-surface-elevated">
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 text-xs text-ink-subtle">全局书签</div>
          <div className="mb-2 space-y-1">
            {bookmarks.map((item, index) => (
              <div key={`${item.path}-${index}`} className="flex items-center gap-2 text-ink">
                <span className="flex-1 truncate">
                  {item.name} · {item.path}
                </span>
                <button
                  type="button"
                  className="text-ink-subtle hover:text-ink"
                  onClick={() => setBookmarks(bookmarks.filter((_, i) => i !== index))}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={bookmarkName}
              onChange={(e) => setBookmarkName(e.target.value)}
              placeholder="名称"
              className="w-28 rounded-md bg-field px-2 py-1 text-ink outline-none"
            />
            <input
              value={bookmarkPath}
              onChange={(e) => setBookmarkPath(e.target.value)}
              placeholder="C:\\path\\to\\dir"
              className="flex-1 rounded-md bg-field px-2 py-1 text-ink outline-none"
            />
            <button
              type="button"
              className="rounded-md bg-field px-2 py-1 text-ink hover:bg-hover"
              title="选择目录"
              onClick={() => {
                void pickDirectory("选择书签目录").then((dir) => {
                  if (dir) setBookmarkPath(dir);
                });
              }}
            >
              <FolderOpen size={14} />
            </button>
            <button
              type="button"
              className="rounded-md bg-active px-2 py-1 text-ink hover:bg-hover"
              onClick={() => {
                if (!bookmarkName.trim() || !bookmarkPath.trim()) return;
                setBookmarks([...bookmarks, { name: bookmarkName.trim(), path: bookmarkPath.trim() }]);
                setBookmarkName("");
                setBookmarkPath("");
              }}
            >
              添加
            </button>
          </div>
        </section>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            className="rounded-md px-3 py-1.5 text-ink-muted hover:text-ink"
            onClick={() => setOpen(false)}
          >
            取消
          </button>
          <button
            type="button"
            className="rounded-md bg-btn px-3 py-1.5 text-btn-fg hover:opacity-90"
            onClick={save}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
