import fs from "node:fs";
import path from "node:path";

// Always-on defence: dependency caches, build outputs, vendor trees,
// language ecosystems, IDE state, OS junk. These are pruned at the
// directory level (via the walk function below) so a node_modules with
// 50k files never gets entered. Both leaf forms (`name` + `name/**`) are
// listed so file-level matching also catches anything that slips past
// directory pruning (e.g. a user pointing the include glob at a sibling
// of an ignored dir).
//
// Patterns are written with a `**/` prefix wherever the entry can appear
// at ANY nesting depth, not just the workspace root. Without that prefix,
// `node_modules` would only prune `./node_modules`, not `./packages/foo/
// node_modules`.
//
// To extend safely: prefer `**/<name>` + `**/<name>/**` pairs and group
// by ecosystem. Avoid generic names like `bin`, `out`, `packages` —
// those are too easy to collide with user content.
const DEFAULT_IGNORE = [
  // ---- Version control ----
  "**/.git", "**/.git/**",
  "**/.svn", "**/.svn/**",
  "**/.hg", "**/.hg/**",
  "**/CVS", "**/CVS/**",

  // ---- OS junk ----
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",

  // ---- Editor / IDE state ----
  "**/.idea", "**/.idea/**",
  "**/.vs", "**/.vs/**",
  // Note: .vscode is intentionally NOT in this list. Many projects commit
  // useful workspace settings (launch.json, tasks.json, recommended
  // extensions) under .vscode/ and users may legitimately want to
  // absorb them. Add per-call via `ignore: ["**/.vscode", ...]` if
  // you need to skip it.

  // ---- Backup / swap files ----
  "**/*~",
  "**/*.swp",
  "**/*.swo",
  "**/*.bak",
  "**/*.orig",
  "**/.#*",

  // ---- Locks / logs / TS build info / sqlite ----
  "**/*.lock",
  "**/*.log",
  "**/*.tsbuildinfo",
  "**/*.sqlite",
  "**/*.sqlite3",
  "**/*.db-journal",

  // ---- Node / JS / TS ecosystem ----
  "**/node_modules", "**/node_modules/**",
  "**/bower_components", "**/bower_components/**",
  "**/jspm_packages", "**/jspm_packages/**",
  "**/.yarn", "**/.yarn/**",
  "**/.pnp.*",
  "**/.pnpm-store", "**/.pnpm-store/**",
  "**/.next", "**/.next/**",
  "**/.nuxt", "**/.nuxt/**",
  "**/.svelte-kit", "**/.svelte-kit/**",
  "**/.remix", "**/.remix/**",
  "**/.astro", "**/.astro/**",
  "**/.docusaurus", "**/.docusaurus/**",
  "**/.vuepress", "**/.vuepress/**",
  "**/.vitepress", "**/.vitepress/**",
  "**/.vercel", "**/.vercel/**",
  "**/.netlify", "**/.netlify/**",
  "**/.firebase", "**/.firebase/**",
  "**/.parcel-cache", "**/.parcel-cache/**",
  "**/.rollup.cache", "**/.rollup.cache/**",
  "**/.turbo", "**/.turbo/**",
  "**/.cache", "**/.cache/**",
  "**/.eslintcache",
  "**/.stylelintcache",
  "**/coverage", "**/coverage/**",
  "**/.nyc_output", "**/.nyc_output/**",

  // ---- Python ----
  "**/__pycache__", "**/__pycache__/**",
  "**/*.pyc",
  "**/.venv", "**/.venv/**",
  "**/venv", "**/venv/**",
  "**/.virtualenv", "**/.virtualenv/**",
  "**/.tox", "**/.tox/**",
  "**/.nox", "**/.nox/**",
  "**/.pytest_cache", "**/.pytest_cache/**",
  "**/.mypy_cache", "**/.mypy_cache/**",
  "**/.pytype", "**/.pytype/**",
  "**/.ruff_cache", "**/.ruff_cache/**",
  "**/.pyre", "**/.pyre/**",
  "**/.ipynb_checkpoints", "**/.ipynb_checkpoints/**",
  "**/*.egg-info", "**/*.egg-info/**",
  "**/site-packages", "**/site-packages/**",
  "**/Pipfile.lock",  // already covered by *.lock but explicit is fine

  // ---- Ruby ----
  "**/.bundle", "**/.bundle/**",

  // ---- Rust / Cargo ----
  // 'target' is also Maven/Scala/SBT — same name, same intent.
  "**/target", "**/target/**",

  // ---- Go ----
  // 'vendor' captured below in the general vendor block; Go modules
  // also produce no separate cache inside the repo by default.

  // ---- Java / Kotlin / Gradle / Maven ----
  "**/.gradle", "**/.gradle/**",
  "**/.mvn", "**/.mvn/**",
  "**/*.class",

  // ---- .NET ----
  "**/obj", "**/obj/**",
  // 'bin' is intentionally NOT here: many projects keep shell scripts,
  // tools, and even committed binaries under 'bin/'. Skipping the whole
  // directory is too aggressive. The default include filter (md/text
  // only) already excludes .NET build artifacts.

  // ---- iOS / macOS / Xcode / Swift ----
  "**/DerivedData", "**/DerivedData/**",
  "**/Pods", "**/Pods/**",
  "**/Carthage", "**/Carthage/**",
  "**/xcuserdata", "**/xcuserdata/**",
  "**/.swiftpm", "**/.swiftpm/**",
  "**/.build", "**/.build/**",

  // ---- Android ----
  // .gradle covered above; build/ covered in the general build block.

  // ---- PHP ----
  "**/composer.phar",

  // ---- Elixir / Erlang ----
  "**/_build", "**/_build/**",
  "**/deps", "**/deps/**",
  "**/.elixir_ls", "**/.elixir_ls/**",

  // ---- Haskell ----
  "**/.stack-work", "**/.stack-work/**",
  "**/dist-newstyle", "**/dist-newstyle/**",

  // ---- Generic build / output dirs ----
  "**/dist", "**/dist/**",
  "**/build", "**/build/**",
  "**/_site", "**/_site/**",      // Jekyll
  "**/.jekyll-cache", "**/.jekyll-cache/**",

  // ---- Vendor / 3rd-party dropbox (general) ----
  "**/vendor", "**/vendor/**",

  // ---- Infrastructure / DevOps state ----
  "**/.terraform", "**/.terraform/**",
  "**/*.tfstate",
  "**/*.tfstate.backup",
  "**/.serverless", "**/.serverless/**",
  "**/.vagrant", "**/.vagrant/**",

  // ---- This boilerplate's own runtime ----
  "**/.memory", "**/.memory/**",
  "**/memory", "**/memory/**",
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

// Caller-supplied ignore patterns are ADDED to the defaults, never used
// as a replacement. The intent: a user passing `ignore: ["secrets/**"]`
// to keep secrets out of an ingest pass should NOT inadvertently re-
// enable scanning of node_modules just because the defaults vanished.
// Returns a fresh array; callers may mutate it freely.
export function mergeIgnore(userIgnore) {
  const extra = Array.isArray(userIgnore) ? userIgnore.filter(Boolean) : [];
  return [...DEFAULT_IGNORE, ...extra];
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
      // into vendor/dify or .git or node_modules.
      if (ignoreRe && matchAny(rel, ignoreRe)) continue;
      yield* walk(full, rel, ignoreRe);
    } else if (entry.isFile()) {
      yield { rel, full };
    }
  }
}

// Caller-supplied `ignore` is MERGED with the defaults, not used as a
// replacement. This guarantees node_modules / .venv / vendor and friends
// can never leak into an ingest pass even when the caller forgets to
// list them. Caller-supplied `include` STILL replaces the default
// include list when non-empty: the include side is a positive choice
// the caller is expected to make precisely.
export function findFiles(rootDir, { include, ignore } = {}) {
  const includeGlobs = include && include.length > 0 ? include : defaultGlobs();
  const ignoreGlobs = mergeIgnore(ignore);
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
