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

// Accepts the per-day name (daily-YYYY-MM-DD.md) and the legacy per-event
// name (daily-YYYY-MM-DD-HHMMSSmmm.md). The time/ms groups are optional so
// pre-accumulation dailies still parse during the migration window.
const DAILY_RE = /^daily-(\d{4})-(\d{2})-(\d{2})(?:-(\d{6})(\d{3}))?\.md$/;
const KNOWLEDGE_RE = /^knowledge-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;
const LESSON_RE = /^lesson-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;

export function parseDailyDocName(name) {
  const m = String(name || "").match(DAILY_RE);
  if (!m) return null;
  const [, y, mo, d, hms, ms] = m;
  return { date: `${y}-${mo}-${d}`, time: hms ?? null, ms: ms ?? null };
}

export function parseKnowledgeDocName(name) {
  const m = String(name || "").match(KNOWLEDGE_RE);
  if (!m) return null;
  const [, slug, y, mo, d, hms, ms] = m;
  return { slug, date: `${y}-${mo}-${d}`, time: hms, ms };
}

export function parseLessonDocName(name) {
  const m = String(name || "").match(LESSON_RE);
  if (!m) return null;
  const [, slug, y, mo, d, hms, ms] = m;
  return { slug, date: `${y}-${mo}-${d}`, time: hms, ms };
}
