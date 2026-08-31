import { open } from "@tauri-apps/plugin-dialog";

export async function pickDirectory(title?: string): Promise<string | null> {
  const selected = await open({
    directory: true,
    multiple: false,
    title: title ?? "选择目录",
  });
  if (typeof selected === "string" && selected.length > 0) return selected;
  return null;
}
