// Container-side mirror of scripts/lib/slug.mjs. Both files MUST produce
// identical document names for the daily/knowledge/lesson families so
// flush.mjs (host) and save_lesson (container) write into the same shape
// that compile.mjs and parseLessonDocName recognise.

export function slugify(text, { maxLen = 60 } = {}) {
  const base = String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) return "untitled";
  return base.slice(0, maxLen).replace(/-+$/g, "") || "untitled";
}

export function timestampUtc(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}` +
    pad(date.getUTCMilliseconds(), 3)
  );
}

export function dateUtc(date = new Date()) {
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function dailyDocName(date = new Date()) {
  return `daily-${dateUtc(date)}.md`;
}

export function dailyDatePath(date = new Date()) {
  return dateUtc(date).replace(/-/g, "/");
}

export function knowledgeDocName(slugOrTitle, date = new Date()) {
  const slug = slugify(slugOrTitle);
  return `knowledge-${slug}-${timestampUtc(date)}.md`;
}

export function lessonDocName(slugOrTitle, date = new Date()) {
  const slug = slugify(slugOrTitle);
  return `lesson-${slug}-${timestampUtc(date)}.md`;
}
