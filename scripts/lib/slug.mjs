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

export function dailyDocName(date = new Date()) {
  return `daily-${timestampUtc(date)}.md`;
}

export function knowledgeDocName(slugOrTitle, date = new Date()) {
  const slug = slugify(slugOrTitle);
  return `knowledge-${slug}-${timestampUtc(date)}.md`;
}

export function lessonDocName(slugOrTitle, date = new Date()) {
  const slug = slugify(slugOrTitle);
  return `lesson-${slug}-${timestampUtc(date)}.md`;
}

const DAILY_RE = /^daily-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;
const KNOWLEDGE_RE = /^knowledge-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;
const LESSON_RE = /^lesson-(.+)-(\d{4})-(\d{2})-(\d{2})-(\d{6})(\d{3})\.md$/;

export function parseDailyDocName(name) {
  const m = String(name || "").match(DAILY_RE);
  if (!m) return null;
  const [, y, mo, d, hms, ms] = m;
  return { date: `${y}-${mo}-${d}`, time: hms, ms };
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
