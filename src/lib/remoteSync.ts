import type { SyncDirection, SyncResult } from "../types";

export function remoteSyncConfigured(project: {
  remote_host?: string;
  remote_user?: string;
  remote_path?: string;
}): boolean {
  return Boolean(project.remote_host?.trim() && project.remote_user?.trim() && project.remote_path?.trim());
}

export function syncConfirmCopy(
  direction: SyncDirection,
  usedGit: boolean,
): { title: string; message: string; danger: boolean } {
  if (direction === "upload") {
    if (usedGit) {
      return {
        title: "上传到远程",
        message:
          "将把本地项目镜像到远程电脑。远程上多出的文件会被删除；.gitignore 中的文件不会上传。",
        danger: false,
      };
    }
    return {
      title: "上传到远程",
      message:
        "当前项目没有 Git 仓库，将同步全部文件，不会按 .gitignore 排除。远程上多出的文件会被删除。",
      danger: true,
    };
  }
  if (usedGit) {
    return {
      title: "从远程下载",
      message:
        "将把远程项目镜像到本地。本地多出的文件会被删除（.gitignore 内的除外）。此操作无法撤销。",
      danger: true,
    };
  }
  return {
    title: "从远程下载",
    message:
      "当前项目没有 Git 仓库，将同步全部文件，不会按 .gitignore 排除。本地多出的文件会被删除。此操作无法撤销。",
    danger: true,
  };
}

export function syncDoneNotice(direction: SyncDirection, result: SyncResult): string {
  const counts = `增加 ${result.added} 个，修改 ${result.modified} 个，删除 ${result.deleted} 个`;
  return direction === "upload" ? `已上传：${counts}` : `已下载：${counts}`;
}
