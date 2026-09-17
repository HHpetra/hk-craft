/** Above xterm.js's ConPTY wrap-fix threshold (21376). */
export const CONPTY_MODERN_BUILD = 22621;

export type WindowsPtyOptions = {
  backend: "conpty";
  buildNumber: number;
};

/**
 * Modern ConPTY wrap handling for xterm.js. Do not set `windowsMode`:
 * that flag applies the pre-21376 wrap hack and shifts CJK at the last column.
 */
export function windowsPtyOptions(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
): WindowsPtyOptions | undefined {
  if (!/windows/i.test(userAgent)) return undefined;
  return { backend: "conpty", buildNumber: CONPTY_MODERN_BUILD };
}
