import { useEffect, useMemo, useState } from "react";
import { Folder, File as FileIcon, LayoutGrid, List, Search } from "lucide-react";
import type { DragEvent } from "react";
import { fsList } from "../../lib/api";
import { breadcrumbParts, cn, formatSize, formatTime } from "../../lib/format";
import type { Bookmark, ExplorerView, FileEntry } from "../../types";
import { useActiveProject, useWorkspace } from "../../store/workspace";

type SortKey = "name" | "modified" | "kind" | "size";

function startDrag(event: DragEvent, path: string) {
  event.dataTransfer.setData("application/x-workbench-path", path);
  event.dataTransfer.setData("text/plain", path);
  event.dataTransfer.effectAllowed = "copy";
}

export function FileExplorer() {
  const project = useActiveProject();
  const bookmarks = useWorkspace((s) => s.config?.bookmarks ?? []);
  const explorerView = (useWorkspace((s) => s.config?.settings.explorer_view) === "icons"
    ? "icons"
    : "list") as ExplorerView;
  const setExplorerView = useWorkspace((s) => s.setExplorerView);
  const [root, setRoot] = useState(project?.path ?? "");
  const [rootLabel, setRootLabel] = useState(project?.name ?? "项目根");
  const [current, setCurrent] = useState(project?.path ?? "");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [filter, setFilter] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortAsc, setSortAsc] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    if (!current) return;
    let cancelled = false;
    void fsList(current)
      .then((list) => {
        if (!cancelled) {
          setEntries(list);
          setError(null);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setEntries([]);
          setError(String(err));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [current]);

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

  function openEntry(entry: FileEntry) {
    if (entry.is_dir) setCurrent(entry.path);
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
            const active =
              root.replace(/\\/g, "/").toLowerCase() === item.path.replace(/\\/g, "/").toLowerCase();
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

        <div className="min-h-0 flex-1 overflow-auto">
          {explorerView === "icons" ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2 p-3">
              {visible.map((entry) => (
                <button
                  key={entry.path}
                  type="button"
                  draggable
                  onDragStart={(e) => startDrag(e, entry.path)}
                  onDoubleClick={() => openEntry(entry)}
                  className="flex flex-col items-center gap-1 rounded-md px-1 py-2 text-ink-muted hover:bg-hover hover:text-ink"
                  title={entry.name}
                >
                  {entry.is_dir ? (
                    <Folder size={28} className="text-sky-500" />
                  ) : (
                    <FileIcon size={28} className="text-ink-subtle" />
                  )}
                  <span className="line-clamp-2 w-full break-all text-center text-[11px]">
                    {entry.name}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <table className="w-full text-left">
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
                    <th key={key} className="px-3 py-2 font-medium">
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
                    draggable
                    onDragStart={(e) => startDrag(e, entry.path)}
                    onDoubleClick={() => openEntry(entry)}
                    className="cursor-default border-t border-line text-ink hover:bg-hover"
                  >
                    <td className="px-3 py-1.5">
                      <span className="flex items-center gap-2">
                        {entry.is_dir ? (
                          <Folder size={14} className="shrink-0 text-sky-500" />
                        ) : (
                          <FileIcon size={14} className="shrink-0 text-ink-subtle" />
                        )}
                        <span className="truncate">{entry.name}</span>
                      </span>
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 text-ink-muted">
                      {formatTime(entry.modified)}
                    </td>
                    <td className="px-3 py-1.5 text-ink-muted">{entry.kind}</td>
                    <td className="px-3 py-1.5 text-ink-muted">
                      {formatSize(entry.size, entry.is_dir)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
