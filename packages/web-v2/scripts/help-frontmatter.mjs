// Front-matter of one help page, read by gen-help-content.mjs and by its test.

/** The audiences a page in content/help/ may be written for. `agent` is not one: pages for
 *  agents are the guide corpus core serves, and the public agent door promises each of them
 *  as markdown at `/api/guides/<slug>.md`, which a page here could not keep. */
export const HELP_AUDIENCES = ["user"];

export function parseFrontmatter(raw) {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const val = line
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    meta[key] = val;
  }
  return { meta, body: raw.slice(m[0].length) };
}

/** The front-matter of a page, refused by name when there is none: a page under content/help/
 *  is published, and a skipped one is a page nobody is told went missing. */
export function readPage(raw, file) {
  const parsed = parseFrontmatter(raw);
  if (!parsed) {
    throw new Error(
      `${file}: no front-matter. Every page under content/help/ except README.md opens with a \`---\` block carrying title, section, order and audience.`,
    );
  }
  return parsed;
}

export function readAudience(meta, file) {
  const audience = meta.audience;
  if (audience === undefined || audience === "") {
    throw new Error(
      `${file}: no \`audience\` in its front-matter. Add \`audience: ${HELP_AUDIENCES.join(" | ")}\` — it decides which door of the public documentation the page sits behind.`,
    );
  }
  if (!HELP_AUDIENCES.includes(audience)) {
    throw new Error(
      `${file}: \`audience: ${audience}\` is not one a help page may hold. Valid: ${HELP_AUDIENCES.join(", ")}.`,
    );
  }
  return audience;
}
