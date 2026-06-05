// Minimal argv parser for the memory-cli.js bridge dispatcher.
//
// Extracted into its own module so it is unit-testable: memory-cli.js
// top-levels its dispatch (with top-level await), so importing that file
// would execute the dispatch. This pure helper has no such side effect.
//
// Supported flag forms:
//   --key=value   value is everything after the FIRST `=`, verbatim. This
//                 is the ONLY unambiguous way to pass a value that itself
//                 starts with `--` (e.g. a free-text search query for a doc
//                 titled "--dry-run --force wiped state"). The host emitter
//                 (scripts/lib/dify-write.mjs buildExecCliArgs) uses this
//                 form for every string value.
//   --key value   two-element form. Kept for backward-compat with shell
//                 callers (dify-setup.sh / plan-capture-smoke.sh) that pass
//                 dash-free values. A value token starting with `--` is
//                 indistinguishable from the next flag, so in this form the
//                 flag is treated as a valueless boolean (= true).
//   --key         valueless boolean (next token is absent or another flag).
// Non-flag tokens accumulate in `_` (positional args).
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const body = a.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        args[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const key = body;
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) {
        args[key] = true;
      } else {
        args[key] = next;
        i += 1;
      }
    } else {
      args._.push(a);
    }
  }
  return args;
}
