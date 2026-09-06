/** DEC private modes that enable terminal mouse reporting. */
const MOUSE_MODES = new Set([9, 1000, 1001, 1002, 1003, 1005, 1006, 1015, 1016]);

const PRIVATE_CSI = /\x1b\[\?([\d;]+)([hl])/g;
const INCOMPLETE_CSI = /^\x1b(?:\[(?:\?(?:\d+(?:;\d+)*)?)?)?$/;

export type MouseStripState = {
  rest: string;
};

export function emptyMouseStripState(): MouseStripState {
  return { rest: "" };
}

function rewritePrivateCsi(params: string, final: string): string {
  const kept = params.split(";").filter((part) => !MOUSE_MODES.has(Number(part)));
  if (!kept.length) return "";
  return `\x1b[?${kept.join(";")}${final}`;
}

function splitIncomplete(input: string): { complete: string; rest: string } {
  const esc = input.lastIndexOf("\x1b");
  if (esc < 0) return { complete: input, rest: "" };
  const tail = input.slice(esc);
  if (!INCOMPLETE_CSI.test(tail)) return { complete: input, rest: "" };
  return { complete: input.slice(0, esc), rest: tail };
}

export function stripMouseTracking(chunk: string, state: MouseStripState): string {
  const { complete, rest } = splitIncomplete(state.rest + chunk);
  state.rest = rest;
  PRIVATE_CSI.lastIndex = 0;
  return complete.replace(PRIVATE_CSI, (_match, params: string, final: string) =>
    rewritePrivateCsi(params, final),
  );
}

export function createMouseStripper() {
  const state = emptyMouseStripState();
  return (chunk: string) => stripMouseTracking(chunk, state);
}
