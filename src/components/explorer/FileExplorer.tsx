import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { Download, Folder, File as FileIcon, LayoutGrid, List, Search, Upload } from "lucide-react";
import type { DragEvent, KeyboardEvent, MouseEvent, PointerEvent, ReactNode } from "react";
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
  syncHasGit,
  syncProject,
} from "../../lib/api";
import { clearFsClipboard, getFsClipboard, setFsClipboard, subscribeFsClipboard } from "../../lib/fsClipboard";
import { fileName, isValidFileName, joinDir, parentDir, uniqueName } from "../../lib/fsNames";
import { beginPathDrag } from "../../lib/dnd";
import { minColumnPct, normalizeColumnWidths, resizeAdjacent } from "../../lib/explorerColumns";
import { deleteConfirmCopy } from "../../lib/explorerDelete";
import { remoteSyncConfigured, syncConfirmCopy, syncDoneNotice } from "../../lib/remoteSync";
import { emptySyncProgress } from "../../lib/syncProgress";
import {
  applyClear,
  applyClick,
  applyContextSelect,
  applySelectAll,
  emptySelection,
  type ExplorerSelection,
} from "../../lib/explorerSelect";
import { breadcrumbParts, cn, formatAgentInject, formatSize, formatTime, pathsEqual } from "../../lib/format";
import type { Bookmark, ExplorerView, FileEntry, Project, SyncDirection, SyncProgress } from "../../types";
import { useWorkspace } from "../../store/workspace";
import { ConfirmDialog } from "../ui/ConfirmDialog";
import { ExplorerContextMenu, type ExplorerMenuAction, type ExplorerMenuState } from "./ExplorerContextMenu";
import { SyncProgressDialog } from "./SyncProgressDialog";

type SortKey = "name" | "modified" | "kind" | "size";

const LIST_COLUMNS: readonly { key: SortKey; label: string }[] = [
  { key: "name", label: "名称" },
  { key: "modified", label: "修改日期" },
  { key: "kind", label: "类型" },
  { key: "size", label: "大小" },
];

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

function startDrag(event: DragEvent, path: string, selected: Set<string>, order: string[]) {
  const paths = selected.has(path) ? order.filter((item) => selected.has(item)) : [path];
  event.dataTransfer.setData("application/x-workbench-path", paths[0] ?? path);
  event.dataTransfer.setData("text/plain", paths.join("\n"));
  event.dataTransfer.effectAllowed = "copy";
  beginPathDrag(paths);
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
      className="min-w-0 flex-1 rounded border border-line bg-field px-1 py-0.5 text-ink outline-none select-text"
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

export function FileExplorer({ project, paneId }: { project: Project; paneId: string }) {
  const bookmarks = useWorkspace((s) => s.config?.bookmarks ?? []);
  const presets = useWorkspace((s) => s.config?.agent_presets ?? []);
  const explorerView = (useWorkspace((s) => s.config?.settings.explorer_view) === "icons"
    ? "icons"
    : "list") as ExplorerView;
  const setExplorerView = useWorkspace((s) => s.setExplorerView);
  const columnWidths = normalizeColumnWidths(
    useWorkspace((s) => s.config?.settings.explorer_column_widths),
  );
  const previewExplorerColumnWidths = useWorkspace((s) => s.previewExplorerColumnWidths);
  const setExplorerColumnWidths = useWorkspace((s) => s.setExplorerColumnWidths);
  const setNotice = useWorkspace((s) => s.setNotice);
  const [root, setRoot] = useState(project?.path ?? "");
  const [rootLabel, setRootLabel] = useState(project?.name ?? "项目根");
  const [current, setCurrent] = useState(project?.path ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<ExplorerSelection>(emptySelection);
  const [focus, setFocus] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<ExplorerMenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileEntry[] | null>(null);
  const [pendingSync, setPendingSync] = useState<SyncDirection | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [activeSync, setActiveSync] = useState<SyncDirection | null>(null);
  const [hasGit, setHasGit] = useState(false);
  const [clip, setClip] = useState(getFsClipboard);
  const paneRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const columnWidthsRef = useRef(columnWidths);
  const columnDragRef = useRef<{
    index: number;
    startX: number;
    startWidths: number[];
    tableWidth: number;
    minPct: number;
  } | null>(null);
  const requestRemoveRef = useRef<(items?: FileEntry[]) => void>(() => undefined);
  const deleteBlockedRef = useRef(false);
  columnWidthsRef.current = columnWidths;

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

  useEffect(() => {
    if (!project?.id) {
      setHasGit(false);
      return;
    }
    let cancelled = false;
    void syncHasGit(project.id)
      .then((value) => {
        if (!cancelled) setHasGit(value);
      })
      .catch(() => {
        if (!cancelled) setHasGit(false);
      });
    return () => {
      cancelled = true;
    };
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
    setSelection(emptySelection());
    setFocus(null);
    setRenaming(null);
    setMenu(null);
    setPendingDelete(null);
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

  const visiblePaths = useMemo(() => visible.map((entry) => entry.path), [visible]);
  const selectedEntries = visible.filter((entry) => selection.selected.has(entry.path));
  const focusEntry =
    (focus && selection.selected.has(focus) ? entries.find((entry) => entry.path === focus) : null) ??
    selectedEntries[0] ??
    null;
  const canPaste = Boolean(clip?.items.length);
  const deleteCopy = pendingDelete ? deleteConfirmCopy(pendingDelete) : null;
  const remoteReady = remoteSyncConfigured(project);
  const syncCopy = pendingSync ? syncConfirmCopy(pendingSync, hasGit) : null;
  const remoteHint = "请先在设置中填写该项目的远程主机、用户名与目录";

  async function runRemoteSync(direction: SyncDirection) {
    setPendingSync(null);
    if (syncing || syncProgress || !remoteReady) return;
    setSyncing(true);
    setActiveSync(direction);
    setSyncProgress(emptySyncProgress(project.id));
    const unlisten = await listen<SyncProgress>("sync-progress", (event) => {
      if (event.payload.project_id !== project.id) return;
      setSyncProgress(event.payload);
    });
    try {
      const result = await syncProject(project.id, direction);
      setSyncProgress((prev) => ({
        ...(prev ?? emptySyncProgress(project.id)),
        phase: "done",
        percent: 100,
        transferred: result.files,
        added: result.added,
        modified: result.modified,
        deleted: result.deleted,
      }));
      setNotice(syncDoneNotice(direction, result));
      if (direction === "download") await reload();
    } catch (err) {
      setSyncProgress((prev) => ({
        ...(prev ?? emptySyncProgress(project.id)),
        phase: "error",
        message: String(err),
      }));
      setNotice(String(err));
    } finally {
      unlisten();
    }
  }

  function setSolo(path: string | null) {
    if (!path) {
      setSelection(emptySelection());
      setFocus(null);
      return;
    }
    setSelection({ selected: new Set([path]), anchor: path });
    setFocus(path);
  }

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortAsc((v) => !v);
    else {
      setSortKey(key);
      setSortAsc(true);
    }
  }

  function onColumnResizePointerDown(event: PointerEvent<HTMLSpanElement>, index: number) {
    event.preventDefault();
    event.stopPropagation();
    const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 0;
    if (tableWidth <= 0) return;
    columnDragRef.current = {
      index,
      startX: event.clientX,
      startWidths: [...columnWidths],
      tableWidth,
      minPct: minColumnPct(tableWidth),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function onColumnResizePointerMove(event: PointerEvent<HTMLSpanElement>) {
    const drag = columnDragRef.current;
    if (!drag || drag.tableWidth <= 0) return;
    const deltaPct = ((event.clientX - drag.startX) / drag.tableWidth) * 100;
    const next = resizeAdjacent(drag.startWidths, drag.index, deltaPct, drag.minPct);
    columnWidthsRef.current = next;
    previewExplorerColumnWidths(next);
  }

  function onColumnResizePointerUp(event: PointerEvent<HTMLSpanElement>) {
    if (!columnDragRef.current) return;
    columnDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void setExplorerColumnWidths(columnWidthsRef.current);
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

  function copyClip(mode: "copy" | "cut", items = selectedEntries) {
    if (!items.length) return;
    setFsClipboard({
      mode,
      items: items.map((entry) => ({
        path: entry.path,
        name: entry.name,
        isDir: entry.is_dir,
      })),
    });
  }

  async function copyText(text: string | null) {
    if (!text) return;
    try {
      await clipboardWriteText(text);
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function pasteHere() {
    const item = getFsClipboard();
    if (!item?.items.length) return;
    const used = entries.map((entry) => entry.name);
    const pasted: string[] = [];
    let failed = false;
    for (const clipItem of item.items) {
      if (item.mode === "cut" && pathsEqual(parentDir(clipItem.path), current)) continue;
      const destName = uniqueName(clipItem.name, used, clipItem.isDir);
      used.push(destName);
      const dest = joinDir(current, destName);
      try {
        const path = item.mode === "cut" ? await fsMove(clipItem.path, dest) : await fsCopy(clipItem.path, dest);
        pasted.push(path);
      } catch (err) {
        setNotice(String(err));
        failed = true;
        break;
      }
    }
    if (!pasted.length) return;
    if (item.mode === "cut" && !failed) clearFsClipboard();
    await reload();
    setSelection({ selected: new Set(pasted), anchor: pasted[0] });
    setFocus(pasted[pasted.length - 1]);
  }

  function requestRemove(items = selectedEntries) {
    if (!items.length || renaming) return;
    setMenu(null);
    setPendingDelete(items);
  }

  requestRemoveRef.current = requestRemove;
  deleteBlockedRef.current = Boolean(pendingDelete || pendingSync || syncProgress || renaming);

  useEffect(() => {
    if (project.active_pane_id !== paneId) return;
    function onKey(event: globalThis.KeyboardEvent) {
      if (event.key !== "Delete") return;
      if (deleteBlockedRef.current || isTypingTarget(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      requestRemoveRef.current();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [paneId, project.active_pane_id]);

  async function confirmRemove() {
    const items = pendingDelete;
    setPendingDelete(null);
    if (!items?.length) return;
    try {
      for (const entry of items) {
        await fsDelete(entry.path);
      }
      const clipNow = getFsClipboard();
      if (clipNow) {
        const remaining = clipNow.items.filter(
          (clipItem) => !items.some((entry) => pathsEqual(clipItem.path, entry.path)),
        );
        if (remaining.length !== clipNow.items.length) {
          if (!remaining.length) clearFsClipboard();
          else setFsClipboard({ ...clipNow, items: remaining });
        }
      }
      setSolo(null);
      await reload();
    } catch (err) {
      setNotice(String(err));
      await reload();
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
      setSolo(renamed);
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
      setSolo(path);
      setRenaming(path);
    } catch (err) {
      setNotice(String(err));
    }
  }

  async function onMenuAction(action: ExplorerMenuAction) {
    const entry = focusEntry;
    switch (action) {
      case "open":
        if (entry) openEntry(entry);
        break;
      case "reveal":
        if (entry) void fsReveal(entry.path).catch((err) => setNotice(String(err)));
        break;
      case "copy":
        copyClip("copy");
        break;
      case "cut":
        copyClip("cut");
        break;
      case "paste":
        await pasteHere();
        break;
      case "copyPath":
        await copyText(selectedEntries.map((item) => item.path).join("\n") || null);
        break;
      case "copyAgentRef":
        await copyText(
          selectedEntries.map((item) => formatAgentInject(item.path, agentPrefix).trimEnd()).join("\n") || null,
        );
        break;
      case "rename":
        if (entry) setRenaming(entry.path);
        break;
      case "delete":
        requestRemove();
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
    if (isTypingTarget(event.target) || pendingDelete || pendingSync || syncProgress) return;
    if (event.key === "F2") {
      event.preventDefault();
      if (focus && selection.selected.has(focus)) setRenaming(focus);
      return;
    }
    if (event.key === "Delete") {
      event.preventDefault();
      requestRemove();
      return;
    }
    const ctrl = event.ctrlKey || event.metaKey;
    if (!ctrl || event.altKey) return;
    const key = event.key.toLowerCase();
    if (key === "a") {
      event.preventDefault();
      setSelection(applySelectAll(visiblePaths));
      setFocus(visible[0]?.path ?? null);
      return;
    }
    if (key === "c") {
      event.preventDefault();
      if (event.shiftKey) {
        void copyText(selectedEntries.map((item) => item.path).join("\n") || current);
      } else copyClip("copy");
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
    setSelection(applyContextSelect(selection, entry.path));
    setFocus(entry.path);
    setMenu({ x: event.clientX, y: event.clientY, kind: "entry" });
  }

  function onBlankContext(event: MouseEvent) {
    if ((event.target as HTMLElement | null)?.closest("[data-entry]")) return;
    event.preventDefault();
    focusPane();
    setSelection(applyClear());
    setFocus(null);
    setMenu({ x: event.clientX, y: event.clientY, kind: "blank" });
  }

  function onEntryClick(event: MouseEvent, entry: FileEntry) {
    focusPane();
    setSelection(
      applyClick(selection, visiblePaths, entry.path, {
        ctrl: event.ctrlKey || event.metaKey,
        shift: event.shiftKey,
      }),
    );
    setFocus(entry.path);
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
          <div className="flex shrink-0">
            <button
              type="button"
              title={remoteReady ? "上传到远程" : remoteHint}
              disabled={!remoteReady || syncing || Boolean(syncProgress)}
              className="rounded p-1 text-ink-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => setPendingSync("upload")}
            >
              <Upload size={14} />
            </button>
            <button
              type="button"
              title={remoteReady ? "从远程下载" : remoteHint}
              disabled={!remoteReady || syncing || Boolean(syncProgress)}
              className="rounded p-1 text-ink-subtle hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => setPendingSync("download")}
            >
              <Download size={14} />
            </button>
          </div>
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
          className="min-h-0 flex-1 overflow-auto outline-none select-none"
          onMouseDown={(event) => {
            if ((event.target as HTMLElement | null)?.closest("[data-entry]")) return;
            focusPane();
            if (event.button === 0) {
              setSelection(applyClear());
              setFocus(null);
            }
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
                  onDragStart={(e) => startDrag(e, entry.path, selection.selected, visiblePaths)}
                  onClick={(event) => onEntryClick(event, entry)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(event) => onEntryContext(event, entry)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md px-1 py-2 text-ink-muted hover:bg-hover hover:text-ink",
                    selection.selected.has(entry.path) && "bg-active text-ink",
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
            <table ref={tableRef} className="w-full table-fixed text-left">
              <colgroup>
                {columnWidths.map((width, index) => (
                  <col key={LIST_COLUMNS[index].key} style={{ width: `${width}%` }} />
                ))}
              </colgroup>
              <thead className="sticky top-0 bg-surface-header text-[11px] uppercase tracking-wide text-ink-subtle">
                <tr>
                  {LIST_COLUMNS.map(({ key, label }, index) => (
                    <th key={key} className="relative min-w-16 px-3 py-2 font-medium">
                      <button type="button" className="truncate" onClick={() => toggleSort(key)}>
                        {label}
                        {sortKey === key ? (sortAsc ? " ↑" : " ↓") : ""}
                      </button>
                      {index < LIST_COLUMNS.length - 1 && (
                        <span
                          role="separator"
                          aria-orientation="vertical"
                          aria-label="调整列宽"
                          className="absolute top-0 right-0 z-10 h-full w-2 translate-x-1/2 cursor-col-resize touch-none"
                          onPointerDown={(event) => onColumnResizePointerDown(event, index)}
                          onPointerMove={onColumnResizePointerMove}
                          onPointerUp={onColumnResizePointerUp}
                          onPointerCancel={onColumnResizePointerUp}
                        />
                      )}
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
                    onDragStart={(e) => startDrag(e, entry.path, selection.selected, visiblePaths)}
                    onClick={(event) => onEntryClick(event, entry)}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(event) => onEntryContext(event, entry)}
                    className={cn(
                      "h-8 cursor-default border-t border-line text-ink hover:bg-hover",
                      selection.selected.has(entry.path) && "bg-active",
                    )}
                  >
                    <td className="min-w-16 overflow-hidden whitespace-nowrap px-3 py-1.5">
                      <span className="flex min-w-0 items-center gap-2">
                        {entry.is_dir ? (
                          <Folder size={14} className="shrink-0 text-sky-500" />
                        ) : (
                          <FileIcon size={14} className="shrink-0 text-ink-subtle" />
                        )}
                        {renderName(entry)}
                      </span>
                    </td>
                    <td className="min-w-16 truncate px-3 py-1.5 text-ink-muted">
                      {formatTime(entry.modified)}
                    </td>
                    <td className="min-w-16 truncate px-3 py-1.5 text-ink-muted">{entry.kind}</td>
                    <td className="min-w-16 truncate px-3 py-1.5 text-ink-muted">
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
      {pendingDelete && deleteCopy && (
        <ConfirmDialog
          title={deleteCopy.title}
          message={deleteCopy.message}
          confirmLabel="删除"
          danger
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void confirmRemove()}
        />
      )}
      {pendingSync && syncCopy && (
        <ConfirmDialog
          title={syncCopy.title}
          message={syncCopy.message}
          confirmLabel={pendingSync === "upload" ? "上传" : "下载"}
          danger={syncCopy.danger}
          onCancel={() => setPendingSync(null)}
          onConfirm={() => void runRemoteSync(pendingSync)}
        />
      )}
      {activeSync && syncProgress && (
        <SyncProgressDialog
          direction={activeSync}
          progress={syncProgress}
          onClose={() => {
            setSyncProgress(null);
            setActiveSync(null);
            setSyncing(false);
          }}
        />
      )}
    </div>
  );
}
