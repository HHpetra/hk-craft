import { useEffect, useState } from "react";
import { FolderOpen, Plus, Trash2, X } from "lucide-react";
import type { AgentPreset, Bookmark } from "../../types";
import { openUrl } from "../../lib/api";
import { SessionStatsOverlay } from "./SessionStatsOverlay";
import {
  APP_COPYRIGHT,
  APP_GIT_HASH,
  APP_GITHUB_URL,
  APP_NAME,
  APP_RELEASES_URL,
  APP_VERSION,
} from "../../lib/appInfo";
import { pickDirectory } from "../../lib/dialog";
import { discoverLocalNerdFonts, listDetectedNerdFonts } from "../../lib/terminalFonts";
import { checkAppUpdate, type UpdateCheck } from "../../lib/updateCheck";
import { normalizeTheme } from "../../lib/theme";
import { useWorkspace } from "../../store/workspace";

export function SettingsDialog() {
  const open = useWorkspace((s) => s.settingsOpen);
  const setOpen = useWorkspace((s) => s.setSettingsOpen);
  const config = useWorkspace((s) => s.config);
  const persist = useWorkspace((s) => s.persist);
  const setTheme = useWorkspace((s) => s.setTheme);
  const setResumeOnStart = useWorkspace((s) => s.setResumeOnStart);
  const setTerminalFont = useWorkspace((s) => s.setTerminalFont);
  const setNotice = useWorkspace((s) => s.setNotice);
  const [presets, setPresets] = useState<AgentPreset[]>([]);
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [projectPresets, setProjectPresets] = useState<Record<string, string>>({});
  const [projectRemotes, setProjectRemotes] = useState<
    Record<string, { host: string; user: string; path: string }>
  >({});
  const [bookmarkName, setBookmarkName] = useState("");
  const [bookmarkPath, setBookmarkPath] = useState("");
  const [nerdFonts, setNerdFonts] = useState<string[]>(() => listDetectedNerdFonts());
  const [update, setUpdate] = useState<UpdateCheck | { status: "checking" }>({ status: "checking" });
  const [statsOpen, setStatsOpen] = useState(false);

  useEffect(() => {
    if (!open) {
      setStatsOpen(false);
      return;
    }
    setUpdate({ status: "checking" });
    void checkAppUpdate().then(setUpdate);
    const current = useWorkspace.getState().config;
    if (!current) return;
    setPresets(current.agent_presets.map((p) => ({ ...p })));
    setBookmarks(current.bookmarks.map((b) => ({ ...b })));
    setProjectPresets(
      Object.fromEntries(current.projects.map((p) => [p.id, p.agent_preset])),
    );
    setProjectRemotes(
      Object.fromEntries(
        current.projects.map((p) => [
          p.id,
          {
            host: p.remote_host ?? "",
            user: p.remote_user ?? "",
            path: p.remote_path ?? "",
          },
        ]),
      ),
    );
    void discoverLocalNerdFonts().then(setNerdFonts);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (statsOpen) {
        setStatsOpen(false);
        return;
      }
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen, statsOpen]);

  if (!open || !config) return null;

  const theme = normalizeTheme(config.settings.theme);

  function openGithub(url: string) {
    void openUrl(url).catch((err) => setNotice(String(err)));
  }

  function refreshUpdate() {
    if (update.status === "checking") return;
    setUpdate({ status: "checking" });
    void checkAppUpdate(true).then(setUpdate);
  }

  const updateLabel =
    update.status === "checking"
      ? "检查更新…"
      : update.status === "latest"
        ? "已是最新"
        : update.status === "outdated"
          ? `有新版本 v${update.latest}`
          : "无法检查更新";

  function save() {
    const current = useWorkspace.getState().config;
    if (!current) return;
    if (presets.length === 0) {
      setNotice("至少保留一个 Agent 预设");
      return;
    }
    const fallback = presets[0].id;
    void persist((latest) => ({
      ...latest,
      agent_presets: presets,
      bookmarks,
      projects: latest.projects.map((project) => {
        const bound = projectPresets[project.id] ?? project.agent_preset;
        const remote = projectRemotes[project.id];
        return {
          ...project,
          agent_preset: presets.some((p) => p.id === bound) ? bound : fallback,
          remote_host: (remote?.host ?? project.remote_host ?? "").trim(),
          remote_user: (remote?.user ?? project.remote_user ?? "").trim(),
          remote_path: (remote?.path ?? project.remote_path ?? "").trim(),
        };
      }),
    })).then((ok) => {
      if (!ok) return;
      setOpen(false);
      useWorkspace.getState().restartOpenedAgentsForPresetChange(current.agent_presets, presets);
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-[2px]">
      <div className="max-h-[85vh] w-[680px] max-w-[90vw] overflow-auto rounded-xl border border-line bg-surface-elevated p-5 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-ink">软件设置</h2>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded p-0.5 text-ink-subtle hover:bg-hover hover:text-ink"
          >
            <X size={15} />
          </button>
        </div>

        <section className="mb-5">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">主题</div>
          <div className="flex gap-2">
            {(["dark", "light"] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => void setTheme(value)}
                className={`rounded-md px-3 py-1.5 text-[12px] ${
                  theme === value ? "bg-btn text-btn-fg" : "bg-field text-ink hover:bg-hover"
                }`}
              >
                {value === "dark" ? "深色" : "浅色"}
              </button>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">终端字体</div>
          <select
            value={config.settings.terminal_font ?? ""}
            onChange={(e) => void setTerminalFont(e.target.value)}
            className="w-full rounded-md bg-field px-2 py-1.5 text-[12px] text-ink outline-none"
          >
            <option value="" className="bg-surface-elevated">
              自动（优先本机 Nerd Font）
            </option>
            {[
              ...new Set([
                ...(config.settings.terminal_font ? [config.settings.terminal_font] : []),
                ...nerdFonts,
              ]),
            ]
              .filter(Boolean)
              .map((family) => (
              <option key={family} value={family} className="bg-surface-elevated">
                {family}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[11px] text-ink-subtle">
            自动模式优先使用本机已安装的 Nerd Font（例如 Maple Mono NF CN），没有再用内置字体。
          </p>
        </section>

        <section className="mb-5">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">Agent 会话</div>
          <label className="flex items-center gap-2 text-[12px] text-ink">
            <input
              type="checkbox"
              checked={config.settings.resume_on_start !== false}
              onChange={(e) => void setResumeOnStart(e.target.checked)}
            />
            启动时按面板恢复上次的 Agent 会话
          </label>
          <p className="mt-1.5 text-[11px] text-ink-subtle">
            每个 Agent 面板会记住当前会话 ID，下次用 --resume / --session 精确接上。多个面板互不影响。终端画面不会恢复。
          </p>
        </section>

        <section className="mb-5">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">终端资源</div>
          <button
            type="button"
            className="rounded-md bg-field px-3 py-1.5 text-[12px] text-ink hover:bg-hover"
            onClick={() => setStatsOpen(true)}
          >
            查看占用
          </button>
          <p className="mt-1.5 text-[11px] text-ink-subtle">按项目查看当前终端进程树的内存与 CPU，不含应用自身。</p>
        </section>

        <section className="mb-5">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-ink-subtle">Agent 预设</span>
            <button
              type="button"
              className="flex items-center gap-1 text-[11px] text-ink-muted hover:text-ink"
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
              <Plus size={11} />
              新增
            </button>
          </div>
          <div className="max-h-48 space-y-1.5 overflow-auto">
            {presets.map((preset, index) => (
              <div key={preset.id} className="grid grid-cols-[1fr_1fr_72px_28px] gap-1.5">
                <input
                  value={preset.name}
                  onChange={(e) => {
                    const next = [...presets];
                    next[index] = { ...preset, name: e.target.value };
                    setPresets(next);
                  }}
                  className="rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
                />
                <input
                  value={preset.command}
                  onChange={(e) => {
                    const next = [...presets];
                    next[index] = { ...preset, command: e.target.value };
                    setPresets(next);
                  }}
                  className="rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
                />
                <input
                  value={preset.drag_prefix}
                  onChange={(e) => {
                    const next = [...presets];
                    next[index] = { ...preset, drag_prefix: e.target.value };
                    setPresets(next);
                  }}
                  className="rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
                />
                <button
                  type="button"
                  className="flex items-center justify-center text-ink-subtle hover:text-red-400"
                  title="删除预设"
                  onClick={() => {
                    if (presets.length <= 1) {
                      setNotice("至少保留一个 Agent 预设");
                      return;
                    }
                    setPresets(presets.filter((p) => p.id !== preset.id));
                  }}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">项目 Agent 绑定</div>
          <div className="space-y-1.5">
            {config.projects.length === 0 && (
              <div className="text-[12px] text-ink-subtle">暂无项目</div>
            )}
            {config.projects.map((project) => (
              <label key={project.id} className="flex items-center gap-2">
                <span className="w-40 truncate text-[12px] text-ink">{project.name}</span>
                <select
                  value={projectPresets[project.id] ?? project.agent_preset}
                  onChange={(e) =>
                    setProjectPresets((s) => ({ ...s, [project.id]: e.target.value }))
                  }
                  className="flex-1 rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
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
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">项目远程同步</div>
          <p className="mb-2 text-[11px] text-ink-subtle">
            按项目填写主机、用户名与远程目录。资源管理器顶栏可 Unison 增量上传 / 下载；需本机与远程安装匹配版本的 Unison，并已配置 SSH 密钥。
          </p>
          <div className="space-y-2">
            {config.projects.length === 0 && (
              <div className="text-[12px] text-ink-subtle">暂无项目</div>
            )}
            {config.projects.map((project) => {
              const remote = projectRemotes[project.id] ?? {
                host: project.remote_host ?? "",
                user: project.remote_user ?? "",
                path: project.remote_path ?? "",
              };
              return (
                <div key={project.id} className="space-y-1">
                  <div className="truncate text-[12px] text-ink">{project.name}</div>
                  <div className="grid grid-cols-[minmax(0,1fr)_7rem_minmax(0,1.4fr)] gap-1.5">
                    <input
                      value={remote.host}
                      onChange={(e) =>
                        setProjectRemotes((s) => ({
                          ...s,
                          [project.id]: { ...remote, host: e.target.value },
                        }))
                      }
                      placeholder="主机 / IP"
                      className="rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
                    />
                    <input
                      value={remote.user}
                      onChange={(e) =>
                        setProjectRemotes((s) => ({
                          ...s,
                          [project.id]: { ...remote, user: e.target.value },
                        }))
                      }
                      placeholder="用户名"
                      className="rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
                    />
                    <input
                      value={remote.path}
                      onChange={(e) =>
                        setProjectRemotes((s) => ({
                          ...s,
                          [project.id]: { ...remote, path: e.target.value },
                        }))
                      }
                      placeholder="/home/user/project"
                      className="rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        <section className="mb-5">
          <div className="mb-2 text-[11px] font-medium uppercase tracking-wider text-ink-subtle">全局书签</div>
          <div className="mb-2 space-y-1">
            {bookmarks.map((item, index) => (
              <div key={`${item.path}-${index}`} className="flex items-center gap-2 text-[12px] text-ink">
                <span className="flex-1 truncate text-ink-muted">
                  {item.name} · {item.path}
                </span>
                <button
                  type="button"
                  className="shrink-0 text-[11px] text-ink-subtle hover:text-red-400"
                  onClick={() => setBookmarks(bookmarks.filter((_, i) => i !== index))}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
          <div className="flex gap-1.5">
            <input
              value={bookmarkName}
              onChange={(e) => setBookmarkName(e.target.value)}
              placeholder="名称"
              className="w-28 rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
            />
            <input
              value={bookmarkPath}
              onChange={(e) => setBookmarkPath(e.target.value)}
              placeholder="C:\\path\\to\\dir"
              className="flex-1 rounded bg-field px-2 py-1 text-[12px] text-ink outline-none"
            />
            <button
              type="button"
              className="rounded bg-field px-2 py-1 text-ink hover:bg-hover"
              title="选择目录"
              onClick={() => {
                void pickDirectory("选择书签目录").then((dir) => {
                  if (dir) setBookmarkPath(dir);
                });
              }}
            >
              <FolderOpen size={13} />
            </button>
            <button
              type="button"
              className="rounded bg-active px-2.5 py-1 text-[12px] text-ink hover:bg-hover"
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

        <div className="mt-4 border-t border-line pt-4">
          <div className="flex justify-end gap-2">
            <button
              type="button"
              className="rounded-md px-3 py-1.5 text-[12px] text-ink-muted hover:text-ink"
              onClick={() => setOpen(false)}
            >
              取消
            </button>
            <button
              type="button"
              className="rounded-md bg-btn px-3 py-1.5 text-[12px] text-btn-fg hover:opacity-90"
              onClick={save}
            >
              保存
            </button>
          </div>
          <footer className="mt-3 border-t border-line pt-3 select-text text-[11px] leading-5 text-ink-subtle">
            <div>
              {APP_NAME} v{APP_VERSION}
              <span className="mx-1.5 opacity-40">·</span>
              <span className="font-mono opacity-60" title="Git commit">
                {APP_GIT_HASH}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5">
              <span>{updateLabel}</span>
              {update.status === "outdated" && (
                <>
                  <span className="opacity-40">·</span>
                  <button
                    type="button"
                    className="text-ink-muted hover:text-ink"
                    onClick={() => openGithub(APP_RELEASES_URL)}
                  >
                    前往下载
                  </button>
                </>
              )}
              {update.status !== "checking" && (
                <>
                  <span className="opacity-40">·</span>
                  <button
                    type="button"
                    className="text-ink-muted hover:text-ink"
                    onClick={refreshUpdate}
                  >
                    检查更新
                  </button>
                </>
              )}
              <span className="opacity-40">·</span>
              <button
                type="button"
                className="text-ink-muted hover:text-ink"
                onClick={() => openGithub(APP_GITHUB_URL)}
              >
                GitHub
              </button>
            </div>
            <div>{APP_COPYRIGHT}</div>
          </footer>
        </div>
      </div>
      <SessionStatsOverlay open={statsOpen} onClose={() => setStatsOpen(false)} />
    </div>
  );
}
