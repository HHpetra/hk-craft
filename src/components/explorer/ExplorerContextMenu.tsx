import { useEffect } from "react";
import { createPortal } from "react-dom";

export type ExplorerMenuAction =
  | "open"
  | "reveal"
  | "copy"
  | "cut"
  | "paste"
  | "copyPath"
  | "copyAgentRef"
  | "rename"
  | "delete"
  | "newFile"
  | "newFolder"
  | "refresh"
  | "copyDirPath";

export type ExplorerMenuState = {
  x: number;
  y: number;
  kind: "entry" | "blank";
};

function Item({
  label,
  disabled,
  danger,
  onPick,
}: {
  label: string;
  disabled?: boolean;
  danger?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      className={`flex w-full px-3 py-1.5 text-left text-[12px] ${
        danger ? "text-red-500" : "text-ink-muted"
      } hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-ink-muted`}
      onClick={onPick}
    >
      {label}
    </button>
  );
}

function Divider() {
  return <div className="my-1 border-t border-line" />;
}

export function ExplorerContextMenu({
  menu,
  canPaste,
  onAction,
  onClose,
}: {
  menu: ExplorerMenuState;
  canPaste: boolean;
  onAction: (action: ExplorerMenuAction) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-explorer-menu]")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  const left = Math.min(menu.x, Math.max(8, window.innerWidth - 200));
  const top = Math.min(menu.y, Math.max(8, window.innerHeight - 320));
  const pick = (action: ExplorerMenuAction) => () => {
    onAction(action);
    onClose();
  };

  return createPortal(
    <div
      data-explorer-menu=""
      className="fixed z-50 min-w-44 rounded-lg border border-line bg-surface-elevated py-1 shadow-xl"
      style={{ left, top }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {menu.kind === "entry" ? (
        <>
          <Item label="打开" onPick={pick("open")} />
          <Item label="在资源管理器中显示" onPick={pick("reveal")} />
          <Divider />
          <Item label="复制" onPick={pick("copy")} />
          <Item label="剪切" onPick={pick("cut")} />
          <Item label="粘贴" disabled={!canPaste} onPick={pick("paste")} />
          <Divider />
          <Item label="复制路径" onPick={pick("copyPath")} />
          <Item label="复制为 Agent 引用" onPick={pick("copyAgentRef")} />
          <Divider />
          <Item label="重命名" onPick={pick("rename")} />
          <Item label="删除" danger onPick={pick("delete")} />
        </>
      ) : (
        <>
          <Item label="粘贴" disabled={!canPaste} onPick={pick("paste")} />
          <Item label="新建文件" onPick={pick("newFile")} />
          <Item label="新建文件夹" onPick={pick("newFolder")} />
          <Divider />
          <Item label="刷新" onPick={pick("refresh")} />
          <Item label="复制当前目录路径" onPick={pick("copyDirPath")} />
        </>
      )}
    </div>,
    document.body,
  );
}
