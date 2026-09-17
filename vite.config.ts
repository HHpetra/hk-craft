import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const env = process.env as Record<string, string | undefined>;
const host = env.TAURI_DEV_HOST;

function appVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version?: string };
    return pkg.version?.trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function gitHash(): string {
  const fromEnv = env.GITHUB_SHA || env.COMMIT_SHA;
  if (fromEnv) return fromEnv.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  // Relative URLs so the embedded custom protocol can resolve JS/CSS.
  base: "./",
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
    __APP_GIT_HASH__: JSON.stringify(gitHash()),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
