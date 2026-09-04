import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Folder, File as FileIcon, LayoutGrid, List, Search } from "lucide-react";
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from "react";
import {
  clipboardWriteText,
  fsCopy,
  fsCreate,
  fsDelete,
  fsList,
  fsMove,
  fsOpen,
  fsRename,
  fsReveal,
} from "../../lib/api";
import { clearFsClipboard, getFsClipboard, setFsClipboard, subscribeFsClipboard } from "../../lib/fsClipboard";
import { fileName, isValidFileName, joinDir, parentDir, uniqueName } from "../../lib/fsNames";
import { beginPathDrag } from "../../lib/dnd";
import { breadcrumbParts, cn, formatAgentInject, formatSize, formatTime, pathsEqual } from "../../lib/format";
import type { Bookmark, ExplorerView, FileEntry, Project } from "../../types";
import { useWorkspace } from "../../store/workspace";
import { ExplorerContextMenu, type ExplorerMenuAction, type ExplorerMenuState } from "./ExplorerContextMenu";

type SortKey = "name" | "modified" | "kind" | "size";

function startDrag(event: DragEvent, path: string) {
  event.dataTransfer.setData("application/x-workbench-path", path);
  event.dataTransfer.setData("text/plain", path);
  event.dataTransfer.effectAllowed = "copy";
  beginPathDrag([path]);
}

function RenameField({
  name,
  onCommit,
  onCancel,
}: {
  name: string;
  onCommit: (next: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(name);
  const cancelled = useRef(false);

  return (
    <input
      autoFocus
      value={draft}
      className="min-w-0 flex-1 rounded border border-line bg-field px-1 py-0.5 text-ink outline-none"
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.target.select()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onBlur={() => {
        if (!cancelled.current) onCommit(draft);
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") {
          event.preventDefault();
          onCommit(draft);
        }
        if (event.key === "Escape") {
          event.preventDefault();
          cancelled.current = true;
          onCancel();
        }
      }}
    />
  );
}

export function FileExplorer({ project }: { project: Project }) {
  const bookmarks = useWorkspace((s) => s.config?.bookmarks ?? []);
  const presets = useWorkspace((s) => s.config?.agent_presets ?? []);
  const explorerView = (useWorkspace((s) => s.config?.settings.explorer_view) === "icons"
    ? "icons"
    : "list") as ExplorerView;
  const setExplorerView = useWorkspace((s) => s.setExplorerView);
  const setNotice = useWorkspace((s) => s.setNotice);
  const [root, setRoot] = useState(project?.path ?? "");
  const [rootLabel, setRootLabel] = useState(project?.name ?? "项目根");
  const [current, setCurrent] = useState(project?.path ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<ExplorerMenuState | null>(null);
  const [clip, setClip] = useState(getFsClipboard);
  const paneRef = useRef<HTMLDivElement>(null);

  const agentPrefix = presets.find((preset) => preset.id === project.agent_preset)?.drag_prefix ?? "@";

  useEffect(() => subscribeFsClipboard(setClip), []);

  useEffect(() => {
    if (!project) {
      setRoot("");
      setCurrent("");
      setEntries([]);
      return;
    }
    setRoot(project.path);
    setRootLabel("项目根");
    setCurrent(project.path);
  }, [project?.id, project?.path]);

  const reload = useCallback(async () => {
    if (!current) return [];
    try {
      const list = await fsList(current);
      setEntries(list);
      setError(null);
      return list;
    } catch (err) {
      setEntries([]);
      setError(String(err));
      return [];
    }
  }, [current]);

  useEffect(() => {
    setSelected(null);
    setRenaming(null);
    setMenu(null);
    void reload();
  }, [reload]);

  const crumbs = useMemo(
    () => (root && current ? breadcrumbParts(root, current, rootLabel) : []),
    [root, current, rootLabel],
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const filtered = q
      ? entries.filter((e) => e.name.toLowerCase().includes(q))
      : entries.slice();
    const dirBoost = (e: FileEntry) => (e.is_dir ? 0 : 1);
    filtered.sort((a, b) => {
      const dir = dirBoost(a) - dirBoost(b);
      if (dir !== 0) return dir;
      let cmp = 0;
      if (sortKey === "name") cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      if (sortKey === "modified") cmp = a.modified - b.modified;
      if (sortKey === "kind") cmp = a.kind.localeCompare(b.kind);
      if (sortKey === "size") cmp = a.size - b.size;
      return sortAsc ? cmp : -cmp;
    });
    return filtered;
  }, [entries, filter, sortKey, sortAsc]);

  const selectedEntry = entries.find((entry) => entry.path === selected) ?? null;
  const canPaste = Boolean(clip);

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function openBookmark(item: Bookmark, label?: string) {
    setRoot(item.path);
    setRootLabel(label ?? item.name);
    setCurrent(item.path);
  }

  function focusPane() {
    paneRef.current?.focus();
  }

  function openEntry(entry: FileEntry) {
    if (entry.is_dir) {
      setCurrent(entry.path);
      return;
    }
    void fsOpen(entry.path).catch((err) => setNotice(String(err)));
  }

  function copyClip(mode: "copy" | "cut", entry = selectedEntry) {
    if (!entry) return;
    setFsClipboard({ mode, path: entry.path, name: entry.name, isDir: entry.is_dir });
  }

  async function copyText(path: string | null) {
    if (!path) return;
    try {
      await clipboardWriteText(path);
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function pasteHere() {
    const item = getFsClipboard();
    if (!item) return;
    if (item.mode === "cut" && pathsEqual(parentDir(item.path), current)) return;
    const destName = uniqueName(
      item.name,
      entries.map((entry) => entry.name),
      item.isDir,
    );
    const dest = joinDir(current, destName);
    try {
      const path = item.mode === "cut" ? await fsMove(item.path, dest) : await fsCopy(item.path, dest);
      if (item.mode === "cut") clearFsClipboard();
      await reload();
      setSelected(path);
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function removeEntry(entry = selectedEntry) {
    if (!entry || renaming) return;
    const kind = entry.is_dir ? "文件夹" : "文件";
    if (!window.confirm(`删除${kind}「${entry.name}」？此操作无法撤销。`)) return;
    try {
      await fsDelete(entry.path);
      if (clip && pathsEqual(clip.path, entry.path)) clearFsClipboard();
      setSelected(null);
      await reload();
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function commitRename(path: string, next: string) {
    const trimmed = next.trim();
    setRenaming(null);
    if (!trimmed || trimmed === fileName(path)) return;
    if (!isValidFileName(trimmed)) {
      setNotice("无效的文件名");
      return;
    }
    try {
      const renamed = await fsRename(path, trimmed);
      await reload();
      setSelected(renamed);
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function createItem(isDir: boolean) {
    const name = uniqueName(
      isDir ? "新建文件夹" : "未命名文件",
      entries.map((entry) => entry.name),
      isDir,
    );
    try {
      const path = await fsCreate(current, name, isDir);
      await reload();
      setSelected(path);
      setRenaming(path);
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function onMenuAction(action: ExplorerMenuAction) {
    const entry = selectedEntry;
    switch (action) {
      case "open":
        if (entry) openEntry(entry);
        break;
      case "reveal":
        if (entry) void fsReveal(entry.path).catch((err) => setNotice(String(err)));
        break;
      case "copy":
        copyClip("copy", entry);
        break;
      case "cut":
        copyClip("cut", entry);
        break;
      case "paste":
        await pasteHere();
        break;
      case "copyPath":
        await copyText(entry?.path ?? null);
        break;
      case "copyAgentRef":
        if (entry) await copyText(formatAgentInject(entry.path, agentPrefix).trimEnd());
        break;
      case "rename":
        if (entry) setRenaming(entry.path);
        break;
      case "delete":
        await removeEntry(entry);
        break;
      case "newFile":
        await createItem(false);
        break;
      case "newFolder":
        await createItem(true);
        break;
      case "refresh":
        await reload();
        break;
      case "copyDirPath":
        await copyText(current);
        break;
      default:
        break;
    }
  }

  function onPaneKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement | null;
    if (target?.tagName === "INPUT" || target?.tagName === "TEXTAREA") return;
    if (event.key === "F2") {
      event.preventDefault();
      if (selected) setRenaming(selected);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      void removeEntry();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "c") {
      event.preventDefault();
      if (event.shiftKey) void copyText(selected ?? current);
      else copyClip("copy");
      return;
    }
    if (event.shiftKey) return;
    if (key === "x") {
      event.preventDefault();
      copyClip("cut");
      return;
    }
    if (key === "v") {
      event.preventDefault();
      void pasteHere();
    }
  }

  function onEntryContext(event: MouseEvent, entry: FileEntry) {
    event.preventDefault();
    event.stopPropagation();
    focusPane();
    setSelected(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, kind: "entry" });
  }

  function onBlankContext(event: MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest("[data-entry]")) return;
    event.preventDefault();
    focusPane();
    setSelected(null);
    setMenu({ x: event.clientX, y: event.clientY, kind: "blank" });
  }

  function renderName(entry: FileEntry, extra?: ReactNode) {
    if (renaming === entry.path) {
      return (
        <RenameField
          name={entry.name}
          onCommit={(next) => void commitRename(entry.path, next)}
          onCancel={() => setRenaming(null)}
        />
      );
    }
    return extra ?? <span className="min-w-0 truncate">{entry.name}</span>;
  }

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center text-ink-subtle">
        请先添加一个项目
      </div>
    );
  }

  const bookmarkItems: Bookmark[] = [
    { name: "项目根", path: project.path },
    ...bookmarks,
  ];

  return (
    <div className="flex h-full min-h-0 bg-surface">
      <aside className="flex w-40 shrink-0 flex-col border-r border-line bg-surface-panel py-2">
        <div className="px-3 pb-2 text-[11px] uppercase tracking-wide text-ink-subtle">
          快捷书签
        </div>
        <div className="flex-1 overflow-auto">
          {bookmarkItems.map((item) => {
            const active = pathsEqual(root, item.path);
            return (
              <button
                key={`${item.name}:${item.path}`}
                type="button"
                onClick={() => openBookmark(item, item.name)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-1.5 text-left text-ink-muted hover:bg-hover hover:text-ink",
                  active && "bg-active text-ink",
                )}
              >
                <Folder size={14} className="shrink-0" />
                <span className="truncate">{item.name}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-auto text-ink-muted">
            {crumbs.map((crumb, i) => (
              <span key={crumb.path} className="flex items-center gap-1">
                {i > 0 && <span className="text-ink-subtle">/</span>}
                <button
                  type="button"
                  className="truncate hover:text-ink"
                  onClick={() => setCurrent(crumb.path)}
                >
                  {crumb.label}
                </button>
              </span>
            ))}
          </nav>
          <label className="flex items-center gap-1 rounded-md bg-field px-2 py-1 text-ink-muted">
            <Search size={13} />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="过滤"
              className="w-28 bg-transparent text-ink outline-none placeholder:text-ink-subtle"
            />
          </label>
          <div className="flex rounded-md bg-field p-0.5">
            <button
              type="button"
              title="详细列表"
              className={cn(
                "rounded p-1 text-ink-subtle hover:text-ink",
                explorerView === "list" && "bg-active text-ink",
              )}
              onClick={() => void setExplorerView("list")}
            >
              <List size={14} />
            </button>
            <button
              type="button"
              title="图标平铺"
              className={cn(
                "rounded p-1 text-ink-subtle hover:text-ink",
                explorerView === "icons" && "bg-active text-ink",
              )}
              onClick={() => void setExplorerView("icons")}
            >
              <LayoutGrid size={14} />
            </button>
          </div>
        </div>

        {error && (
          <div className="border-b border-line px-3 py-2 text-amber-600">{error}</div>
        )}

        <div
          ref={paneRef}
          tabIndex={0}
          className="min-h-0 flex-1 overflow-auto outline-none"
          onMouseDown={(event) => {
            if ((event.target as HTMLElement | null)?.closest("[data-entry]")) return;
            focusPane();
            if (event.button === 0) setSelected(null);
          }}
          onContextMenu={onBlankContext}
          onKeyDown={onPaneKeyDown}
        >
          {explorerView === "icons" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 p-3">
              {visible.map((entry) => (
                <div
                  key={entry.path}
                  role="button"
                  tabIndex={-1}
                  data-entry=""
                  draggable={renaming !== entry.path}
                  onDragStart={(e) => startDrag(e, entry.path)}
                  onClick={() => {
                    focusPane();
                    setSelected(entry.path);
                  }}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(event) => onEntryContext(event, entry)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md px-1 py-2 text-ink-muted hover:bg-hover hover:text-ink",
                    selected === entry.path && "bg-active text-ink",
                  )}
                  title={entry.name}
                >
                  {entry.is_dir ? (
                    <Folder size={28} className="text-sky-500" />
                  ) : (
                    <FileIcon size={28} className="text-ink-subtle" />
                  )}
                  {renaming === entry.path ? (
                    renderName(entry)
                  ) : (
                    <span className="line-clamp-2 w-full break-all text-center text-[11px]">
                      {entry.name}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <table className="w-full table-fixed text-left">
              <colgroup>
                <col className="w-[42%]" />
                <col className="w-[28%]" />
                <col className="w-[16%]" />
                <col className="w-[14%]" />
              </colgroup>
              <thead className="sticky top-0 bg-surface-header text-[11px] uppercase tracking-wide text-ink-subtle">
                <tr>
                  {(
                    [
                      ["name", "名称"],
                      ["modified", "修改日期"],
                      ["kind", "类型"],
                      ["size", "大小"],
                    ] as const
                  ).map(([key, label]) => (
                    <th key={key} className="truncate px-3 py-2 font-medium">
                      <button type="button" onClick={() => toggleSort(key)}>
                        {label}
                        {sortKey === key ? (sortAsc ? " ↑" : " ↓") : ""}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((entry) => (
                  <tr
                    key={entry.path}
                    data-entry=""
                    draggable={renaming !== entry.path}
                    onDragStart={(e) => startDrag(e, entry.path)}
                    onClick={() => {
                      focusPane();
                      setSelected(entry.path);
                    }}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(event) => onEntryContext(event, entry)}
                    className={cn(
                      "h-8 cursor-default border-t border-line text-ink hover:bg-hover",
                      selected === entry.path && "bg-active",
                    )}
                  >
                    <td className="overflow-hidden whitespace-nowrap px-3 py-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        {entry.is_dir ? (
                          <Folder size={14} className="shrink-0 text-sky-500" />
                        ) : (
                          <FileIcon size={14} className="shrink-0 text-ink-subtle" />
                        )}
                        {renderName(entry)}
                      </span>
                    </td>
                    <td className="truncate px-3 py-1.5 text-ink-muted">
                      {formatTime(entry.modified)}
                    </td>
                    <td className="truncate px-3 py-1.5 text-ink-muted">{entry.kind}</td>
                    <td className="truncate px-3 py-1.5 text-ink-muted">
                      {formatSize(entry.size, entry.is_dir)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      {menu && (
        <ExplorerContextMenu
          menu={menu}
          canPaste={canPaste}
          onAction={(action) => void onMenuAction(action)}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
