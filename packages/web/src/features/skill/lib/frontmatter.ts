/**
 * SKILL.md YAML-frontmatter parse/serialize for the web Skill Studio editor.
 *
 * Mirrors the value subset that `core/src/skills/parse-manifest.ts` understands
 * (`key: value`, `true/false`, `[a, b, c]`) so what the form writes round-trips
 * through the server parser. Two deliberate differences from the core parser:
 *   1. A MISSING frontmatter block is tolerated (returns `{ frontmatter: {},
 *      body: skillMd }`) instead of throwing — the web editor works on
 *      user-authored content that may not yet have a block.
 *   2. `serializeFrontmatter` owns only the four form-managed keys (`name`,
 *      `description`, `allowed-tools`, `target`) and passes through every other
 *      key from the original frontmatter VERBATIM, so unknown keys authored by
 *      hand are never dropped or reordered (round-trip safety).
 */

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/** The four keys the frontmatter form manages directly. */
export interface FrontmatterFields {
  name: string;
  description: string;
  /** Parsed from / serialized to the `allowed-tools` YAML list. */
  allowedTools: string[];
  target: 'dev' | 'cloud' | 'all' | '';
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Keys owned by the form, in the stable order they are written. */
const KNOWN_KEYS = ['name', 'description', 'allowed-tools', 'target'] as const;

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

/**
 * Parse the leading `--- ... ---` YAML block. Tolerates a missing block by
 * returning an empty frontmatter and the whole input as the body.
 */
export function parseFrontmatter(skillMd: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(skillMd ?? '');
  if (!match) {
    return { frontmatter: {}, body: skillMd ?? '' };
  }
  const [, block, body = ''] = match;
  const frontmatter: Record<string, unknown> = {};

  for (const line of (block ?? '').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    if (!key) continue;
    frontmatter[key] = parseValue(line.slice(colon + 1));
  }

  return { frontmatter, body };
}

/** Map a parsed frontmatter object onto the form's four managed fields. */
export function fieldsFromFrontmatter(
  frontmatter: Record<string, unknown>,
  fallback: Partial<FrontmatterFields> = {},
): FrontmatterFields {
  const rawTools = frontmatter['allowed-tools'];
  const allowedTools = Array.isArray(rawTools)
    ? rawTools.map((t) => String(t)).filter(Boolean)
    : fallback.allowedTools ?? [];
  const rawTarget = frontmatter['target'];
  const target =
    rawTarget === 'dev' || rawTarget === 'cloud' || rawTarget === 'all'
      ? rawTarget
      : fallback.target ?? '';
  return {
    name: typeof frontmatter['name'] === 'string' ? (frontmatter['name'] as string) : fallback.name ?? '',
    description:
      typeof frontmatter['description'] === 'string'
        ? (frontmatter['description'] as string)
        : fallback.description ?? '',
    allowedTools,
    target,
  };
}

function serializeValue(val: unknown): string {
  if (Array.isArray(val)) {
    return `[${val.map((v) => String(v)).join(', ')}]`;
  }
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  return String(val);
}

/**
 * Re-emit a `--- ... ---` block + body. The four managed fields are written
 * first in {@link KNOWN_KEYS} order (skipping empty values), then every key in
 * `originalFrontmatter` that the form does not own is appended verbatim, in its
 * original order. If nothing would be written, the body is returned as-is.
 */
export function serializeFrontmatter(
  fields: FrontmatterFields,
  body: string,
  originalFrontmatter: Record<string, unknown> = {},
): string {
  const managed: Record<string, unknown> = {
    name: fields.name.trim(),
    description: fields.description.trim(),
    'allowed-tools': fields.allowedTools,
    target: fields.target,
  };

  const lines: string[] = [];
  for (const key of KNOWN_KEYS) {
    const val = managed[key];
    if (val === undefined || val === '') continue;
    if (Array.isArray(val) && val.length === 0) continue;
    lines.push(`${key}: ${serializeValue(val)}`);
  }
  for (const key of Object.keys(originalFrontmatter)) {
    if ((KNOWN_KEYS as readonly string[]).includes(key)) continue;
    lines.push(`${key}: ${serializeValue(originalFrontmatter[key])}`);
  }

  if (lines.length === 0) return body;
  return `---\n${lines.join('\n')}\n---\n${body}`;
}
