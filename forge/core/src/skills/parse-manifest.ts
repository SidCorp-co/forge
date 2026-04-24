/**
 * Minimal YAML-frontmatter parser for bundled SKILL.md files.
 *
 * Supports the subset the 8 built-in forge-* skills actually use:
 *   key: value            -> string (quotes trimmed)
 *   key: true | false     -> boolean
 *   key: [a, b, c]        -> string[]
 *
 * Anything else is kept as a raw string. A missing opening `---` or closing
 * `---` throws — built-in files are authored, not user content, so we prefer
 * loud failure during seeding over silent truncation.
 */

export interface ParsedManifest {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function unquote(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

function parseValue(raw: string): unknown {
  const t = raw.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => unquote(s));
  }
  return unquote(t);
}

export function parseManifest(raw: string): ParsedManifest {
  const match = FRONTMATTER_RE.exec(raw);
  if (!match) {
    throw new Error('SKILL.md is missing required YAML frontmatter (--- ... ---)');
  }
  const [, block, body = ''] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const line of (block ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1);
    if (!key) continue;
    frontmatter[key] = parseValue(value);
  }

  return { frontmatter, body };
}
