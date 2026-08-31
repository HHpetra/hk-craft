import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let requested = false;

export async function notifyTaskDone(title: string, body: string) {
  try {
    let granted = await isPermissionGranted();
    if (!granted && !requested) {
      requested = true;
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) return;
    sendNotification({ title, body });
  } catch {
    // notifications are best-effort
  }
}
