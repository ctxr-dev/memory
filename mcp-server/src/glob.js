import fs from "node:fs";
import path from "node:path";

const DEFAULT_IGNORE = [
  ".git",
  ".git/**",
  "node_modules",
  "node_modules/**",
  ".memory",
  ".memory/**",
  "memory",
  "memory/**",
  "vendor",
  "vendor/**",
  "dist",
  "dist/**",
  "build",
  "build/**",
  ".next",
  ".next/**",
  ".cache",
  ".cache/**",
  ".turbo",
  ".turbo/**",
  "**/.DS_Store",
  "*.lock",
  "*.log",
];

const DEFAULT_DOC_GLOBS = [
  "**/*.md",
  "**/*.mdx",
  "**/*.markdown",
  "**/*.txt",
  "**/*.rst",
  "**/*.adoc",
];

export function defaultGlobs() {
  return [...DEFAULT_DOC_GLOBS];
}

export function defaultIgnore() {
  return [...DEFAULT_IGNORE];
}

function escapeRegex(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "/") {
      out += "/";
    } else {
      out += escapeRegex(c);
    }
  }
  return new RegExp(`^${out}$`);
}

export function compileGlobs(patterns) {
  return patterns.map(globToRegex);
}

export function matchAny(relPath, regexes) {
  for (const re of regexes) {
    if (re.test(relPath)) return true;
  }
  return false;
}

function* walk(rootDir, relPrefix, ignoreRe) {
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    const full = path.join(rootDir, entry.name);
    // Skip symlinks entirely so /workspace cannot be escaped via a link.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      // Prune ignored directories at the directory level so we don't recurse
      // into vendor/dify or .git.
      if (ignoreRe && matchAny(rel, ignoreRe)) continue;
      yield* walk(full, rel, ignoreRe);
    } else if (entry.isFile()) {
      yield { rel, full };
    }
  }
}

export function findFiles(rootDir, { include, ignore } = {}) {
  const includeGlobs = include && include.length > 0 ? include : defaultGlobs();
  const ignoreGlobs = ignore && ignore.length > 0 ? ignore : defaultIgnore();
  const includeRe = compileGlobs(includeGlobs);
  const ignoreRe = compileGlobs(ignoreGlobs);

  const out = [];
  for (const entry of walk(rootDir, "", ignoreRe)) {
    if (matchAny(entry.rel, ignoreRe)) continue;
    if (!matchAny(entry.rel, includeRe)) continue;
    let stat;
    try {
      stat = fs.statSync(entry.full);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    out.push({
      relPath: entry.rel,
      absPath: entry.full,
      size: stat.size,
      mtime: stat.mtime?.toISOString?.() || null,
    });
  }
  out.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return out;
}

export function relPathToDocName(relPath) {
  return String(relPath).replace(/\\/g, "/").replace(/\//g, "_");
}
