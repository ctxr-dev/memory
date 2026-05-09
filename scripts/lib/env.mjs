import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
export const MEMORY_DIR = path.resolve(here, "../..");
export const WORKSPACE_DIR = path.resolve(MEMORY_DIR, "..");
export const ENV_PATH = path.join(MEMORY_DIR, ".env");
export const COMPILE_STATE_PATH = path.join(MEMORY_DIR, ".compile-state.json");
export const PROMPTS_DIR = path.join(MEMORY_DIR, "prompts");

export function readEnvFile(file = ENV_PATH) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i === -1) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

export function envValue(name, fallback = "") {
  if (process.env[name] != null && process.env[name] !== "") return process.env[name];
  const file = readEnvFile();
  return file[name] ?? fallback;
}

export function envInt(name, fallback) {
  const raw = envValue(name, "");
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
