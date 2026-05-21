// Pure helpers backing the `audit_memory` MCP tool. Kept in a separate
// module so tests can import them without dragging in @modelcontextprotocol
// (which lives in mcp-server/node_modules and isn't on the host test path).
//
// Each finder takes an array of Dify document objects (the shape returned
// by `listAllDocuments`) and returns a list of { class, slot, documentId,
// name, reason, suggested_action } findings. The tool surface in index.js
// just wires these together with `listAllDocuments` and a per-slot loop.

// Flatten doc.doc_metadata (Dify shape: [{ id, name, value, type }]) into a
// key->value object so the finders can read fields by name without an
// inner .find() at every access.
export function indexDocMetadata(doc) {
  const md = {};
  // Guard with Array.isArray: `doc?.doc_metadata || []` only handles
  // null/undefined. If Dify ever returns a non-array truthy value (an
  // object, a string), `for..of` would throw and abort the whole audit
  // run. Treat any non-array shape as "no metadata".
  const fields = Array.isArray(doc?.doc_metadata) ? doc.doc_metadata : [];
  for (const f of fields) {
    if (f?.name) md[f.name] = f.value;
  }
  return md;
}

// Stale-plans: in the `plans` slot, flag an older `plan-<slug>.md` doc
// when a NEWER `plan-<slug>-<...>.md` doc extends its slug — the
// signature of a title rename that left the old slug behind.
//
// Two guards keep false positives out (round-40 reviewer findings):
//   1. Only docs matching the `^plan-.*\.md$` naming convention are
//      considered. A hand-added non-plan doc in the plans slot is left
//      alone.
//   2. The rename signal is DELIMITER-AWARE: `newerSlug.startsWith(
//      olderSlug + "-")`, not a bare substring. Bare `includes` would
//      flag `plan-auth.md` as stale just because `plan-oauth.md`
//      exists ("auth" ⊂ "oauth") — a textbook false positive. Requiring
//      the older slug to be a hyphen-delimited PREFIX of the newer one
//      means only `plan-auth.md` → `plan-auth-rewrite.md` matches, not
//      `plan-auth.md` vs `plan-oauth.md` or `plan-authz.md`.
// Same-name docs (the upsert-by-name identity-overwrite path) are never
// flagged: they have equal slugs so the startsWith(... + "-") check is
// false.
const PLAN_NAME_RE = /^plan-.*\.md$/;
export function findStalePlans(docs) {
  const findings = [];
  const sorted = [...(docs || [])]
    .filter((d) => d?.id && d?.name && PLAN_NAME_RE.test(String(d.name)))
    .sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0));
  for (let i = 0; i < sorted.length; i += 1) {
    const older = sorted[i];
    const olderSlug = String(older.name).replace(/\.md$/, "").replace(/^plan-/, "");
    if (!olderSlug) continue;
    for (let j = i + 1; j < sorted.length; j += 1) {
      const newer = sorted[j];
      const newerSlug = String(newer.name).replace(/\.md$/, "").replace(/^plan-/, "");
      if (olderSlug === newerSlug) continue;
      if (newerSlug.startsWith(`${olderSlug}-`)) {
        findings.push({
          class: "stale-plans",
          slot: "plans",
          documentId: older.id,
          name: older.name,
          reason: `slug '${olderSlug}' is a hyphen-delimited prefix of newer doc '${newer.name}' (created_at ${older.created_at} -> ${newer.created_at}); likely a title-rename leftover`,
          suggested_action: "delete",
        });
        break;
      }
    }
  }
  return findings;
}

// Atom-type -> list of metadata fields required by the documented
// contract (templates/skills/self-improvement.md + prompts/flush.md).
// A doc is flagged if its atom_type appears here and any required
// field is missing or whitespace-only.
const REQUIRED_METADATA_BY_TYPE = {
  "self-improvement-lesson": ["project_module", "task_type", "error_pattern"],
  "bug-root-cause": ["project_module"],
};

export function findMissingMetadata(docs, slotName) {
  const findings = [];
  for (const doc of docs || []) {
    if (!doc?.id || !doc?.name) continue;
    const md = indexDocMetadata(doc);
    const type = md.atom_type;
    const required = REQUIRED_METADATA_BY_TYPE[type];
    if (!required) continue;
    const missing = required.filter((f) => !String(md[f] || "").trim());
    if (missing.length === 0) continue;
    findings.push({
      class: "missing-metadata",
      slot: slotName,
      documentId: doc.id,
      name: doc.name,
      reason: `atom_type='${type}' missing required metadata: ${missing.join(", ")}`,
      suggested_action: "disable",
    });
  }
  return findings;
}

// Stale project-lore. The atom-type doc says "Decays fast — include dates."
// Configurable threshold; default 90 days at the tool boundary.
export function findStaleProjectLore(docs, slotName, staleDays, now = Date.now()) {
  const findings = [];
  const cutoffMs = staleDays * 24 * 60 * 60 * 1000;
  for (const doc of docs || []) {
    if (!doc?.id || !doc?.name) continue;
    const md = indexDocMetadata(doc);
    if (md.atom_type !== "project-lore") continue;
    const createdMs = Number(doc.created_at || 0) * 1000;
    if (!createdMs) continue;
    const age = now - createdMs;
    if (age < cutoffMs) continue;
    const days = Math.floor(age / (24 * 60 * 60 * 1000));
    findings.push({
      class: "stale-project-lore",
      slot: slotName,
      documentId: doc.id,
      name: doc.name,
      reason: `project-lore doc is ${days} days old (threshold=${staleDays} days); decays fast per the type definition`,
      suggested_action: "disable",
    });
  }
  return findings;
}

// Duplicate error_pattern lessons. Phase-2.1's forcedLessonUpdate
// prevents NEW duplicates at compile time but legacy duplicates from
// the old behaviour still need cleanup. Canonical = most recently
// created in each group; older entries flagged as suggested deletes.
export function findDuplicateErrorPatternLessons(docs, slotName) {
  const groups = new Map();
  for (const doc of docs || []) {
    if (!doc?.id || !doc?.name) continue;
    const md = indexDocMetadata(doc);
    if (md.atom_type !== "self-improvement-lesson") continue;
    const ep = String(md.error_pattern || "").trim();
    if (!ep) continue;
    if (!groups.has(ep)) groups.set(ep, []);
    groups.get(ep).push(doc);
  }
  const findings = [];
  for (const [ep, group] of groups) {
    if (group.length < 2) continue;
    const sorted = [...group].sort(
      (a, b) => Number(b.created_at || 0) - Number(a.created_at || 0),
    );
    const canonical = sorted[0];
    for (const dupe of sorted.slice(1)) {
      findings.push({
        class: "duplicate-error-pattern",
        slot: slotName,
        documentId: dupe.id,
        name: dupe.name,
        reason: `lesson shares error_pattern='${ep}' with newer canonical '${canonical.name}' (id=${canonical.id})`,
        suggested_action: "delete",
      });
    }
  }
  return findings;
}
