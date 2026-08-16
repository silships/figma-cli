/**
 * Reading ONE section out of the usage guide instead of the whole file.
 *
 * The guide is ~10k tokens. An agent told to "read the docs first" pays that
 * on every session, even when the task needs one 900-token section. Splitting
 * it by `##` heading lets a caller pull just what it needs.
 *
 * Pure string work, so the matching is unit-tested without touching disk.
 */

/** Heading text → a stable slug: lowercase words, everything else a dash. */
export function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')   // drop parenthetical asides
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Split a markdown document at its `##` headings.
 *
 * `###` and deeper stay inside their parent section — they are subsections of
 * the topic, not topics of their own. Text before the first `##` (the title) is
 * dropped: it carries no topic.
 *
 * @returns {{heading: string, slug: string, body: string, tokens: number}[]}
 */
export function parseSections(markdown) {
  const lines = markdown.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    const isTopLevel = /^##\s+/.test(line) && !/^###/.test(line);
    if (isTopLevel) {
      if (current) sections.push(current);
      const heading = line.replace(/^##\s+/, '').trim();
      current = { heading, slug: slugify(heading), body: line + '\n' };
      continue;
    }
    if (current) current.body += line + '\n';
  }
  if (current) sections.push(current);

  // ≈ tokens, for the listing. Bytes/4 is the usual rough rule; it only has to
  // be good enough to tell a 900-token section from a 2000-token one.
  for (const s of sections) {
    s.body = s.body.replace(/\n+$/, '\n');
    s.tokens = Math.round(s.body.length / 4);
  }
  return sections;
}

/**
 * Find the sections a query asks for.
 *
 * Ranked, because a query should not have to be exact:
 *   1. slug is exactly the query          "jsx-syntax"  → JSX Syntax
 *   2. a slug word is exactly the query   "jsx"         → JSX Syntax
 *   3. slug contains the query            "pitfall"     → Critical Pitfalls
 *   4. heading contains the query          "render"     → JSX Syntax (render command)
 *
 * Returns every section at the best tier that matched, so an ambiguous query
 * ("token" → Design Tokens + Token Hygiene) can be reported rather than
 * silently resolved to whichever came first.
 */
export function matchSections(sections, query) {
  const q = slugify(String(query || ''));
  if (!q) return [];

  // "token" should find "Design Tokens" as readily as "Token Hygiene", so a
  // trailing plural s is ignored on both sides of a word comparison.
  const singular = (w) => w.replace(/s$/, '');
  const qs = singular(q);

  const tiers = [
    (s) => s.slug === q,
    (s) => s.slug.split('-').some((w) => singular(w) === qs),
    (s) => s.slug.includes(q),
    (s) => slugify(s.heading).includes(q) || s.heading.toLowerCase().includes(query.toLowerCase()),
  ];

  for (const test of tiers) {
    const hits = sections.filter(test);
    if (hits.length) return hits;
  }
  return [];
}
