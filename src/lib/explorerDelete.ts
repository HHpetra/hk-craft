export function deleteConfirmCopy(items: { name: string; is_dir: boolean }[]): {
  title: string;
  message: string;
} {
  if (items.length === 1) {
    const kind = items[0].is_dir ? "文件夹" : "文件";
    return {
      title: "确认删除",
      message: `确定删除${kind}「${items[0].name}」吗？此操作无法撤销。`,
    };
  }
  return {
    title: "确认删除",
    message: `确定删除这 ${items.length} 项吗？此操作无法撤销。`,
  };
}
