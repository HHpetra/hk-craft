import { fetchLatestReleaseTag } from "./api";
import { APP_REPO, APP_VERSION } from "./appInfo";

export type UpdateCheck = {
  status: "latest" | "outdated" | "unknown";
  latest?: string;
};

let cached: Promise<UpdateCheck> | null = null;

function parseSemver(raw: string): [number, number, number] | null {
  const match = raw.trim().replace(/^v/i, "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compare(a: [number, number, number], b: [number, number, number]) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

function displayTag(tag: string) {
  return tag.trim().replace(/^v/i, "");
}

async function fetchLatest(): Promise<UpdateCheck> {
  try {
    const tag = (await fetchLatestReleaseTag(APP_REPO)).trim();
    if (!tag) return { status: "unknown" };
    const remote = parseSemver(tag);
    const local = parseSemver(APP_VERSION);
    const latest = displayTag(tag);
    if (!remote || !local) return { status: "unknown", latest };
    if (compare(remote, local) > 0) return { status: "outdated", latest };
    return { status: "latest", latest };
  } catch {
    return { status: "unknown" };
  }
}

export function checkAppUpdate(force = false) {
  if (force) cached = null;
  if (cached) return cached;
  const pending = fetchLatest().then((result) => {
    if (result.status === "unknown") cached = null;
    return result;
  });
  cached = pending;
  return pending;
}
