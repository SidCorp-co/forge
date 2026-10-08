// The frontmatter of a shipped skill, read the way an installer that enforces the Agent Skills
// spec reads it, and judged against that spec's limits. A skill's `name` and `description` are all
// a model sees before it opens the file, and an installer that rejects either drops the skill whole
// rather than truncating, so the failure is a skill nobody is offered and a build that stays green.

export const NAME_LIMIT = 64;
export const DESCRIPTION_LIMIT = 1024;

const PLAIN_INDICATORS = /^[[{*&!%@`]/;
// What YAML reads as structure inside a plain scalar: a mapping value, or the start of a comment.
const PLAIN_STRUCTURE = /: |:$| #/;
// An HTML-shaped tag. A validator that parses a description as markup, or rejects a placeholder, fails here.
const PLACEHOLDER = /<[A-Za-z/!?][^<>]*>/g;

/** The characters no YAML stream may carry, bar the tab and the newline. */
function unprintable(text) {
  return [...text].filter((c) => {
    const code = c.charCodeAt(0);
    return (code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f;
  });
}

/**
 * The top-level fields of a `---` fenced frontmatter block, each as the string a YAML parser would
 * hand an installer. Values of other keys are skipped by shape. A line this cannot read is an error
 * that names the line, never a guess.
 *
 * @returns {{ fields: Map<string, { value?: string, line: number, error?: string }> } | { error: string, line: number }}
 */
export function parseFrontmatter(raw) {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (lines[0].trimEnd() !== '---') {
    return { error: 'the file does not open with a `---` line', line: 1 };
  }
  const end = lines.findIndex((l, i) => i > 0 && l.trimEnd() === '---');
  if (end === -1) return { error: 'the frontmatter has no closing `---` line', line: 1 };

  const fields = new Map();
  let current = null;
  for (let i = 1; i < end; i++) {
    const text = lines[i];
    const n = i + 1;
    if (text.trim() === '' || /^\s/.test(text)) {
      current?.body.push({ text, n });
      continue;
    }
    if (text.startsWith('#')) continue;
    const m = /^([A-Za-z0-9_-]+):(?:[ \t]+(.*)|[ \t]*)$/.exec(text);
    if (!m) {
      return { error: `line ${n} is not \`key: value\`: ${shown(text)}`, line: n };
    }
    if (fields.has(m[1])) {
      return {
        error: `\`${m[1]}\` is declared twice, on lines ${fields.get(m[1]).line} and ${n}`,
        line: n,
      };
    }
    current = { key: m[1], line: n, rest: (m[2] ?? '').trimEnd(), body: [] };
    fields.set(m[1], current);
  }
  for (const [key, f] of fields) fields.set(key, scalar(f));
  return { fields };
}

function shown(text) {
  return text.length > 60 ? `${JSON.stringify(text.slice(0, 57))}…` : JSON.stringify(text);
}

function scalar(f) {
  const { rest, body, line } = f;
  const fail = (error) => ({ line, error });
  const block = /^([>|])([+-]?)(\d?)([+-]?)\s*(#.*)?$/.exec(rest);
  if (block) return { line, value: blockScalar(block, body) };
  const continuation = body.map((b) => b.text.trim());
  if (rest === '') {
    const nested = continuation.find((t) => t !== '');
    if (nested === undefined) return { line, value: '' };
    if (/^-(\s|$)/.test(nested) || /^[A-Za-z0-9_-]+:(\s|$)/.test(nested)) {
      return fail('is a list or a mapping, which an installer does not read as a string');
    }
    return plain(continuation, line);
  }
  if (rest.startsWith('"')) return quoted(rest, continuation, '"', line);
  if (rest.startsWith("'")) return quoted(rest, continuation, "'", line);
  return plain([rest, ...continuation], line);
}

/** A plain scalar, which a YAML parser folds across its lines into one run of text. */
function plain(parts, line) {
  const text = parts.filter((t) => t !== '').join(' ');
  // A value that opens with `#` is a comment, and YAML reads the key as empty.
  if (text.startsWith('#')) return { line, value: '' };
  const implicit = nonString(text);
  if (implicit) {
    return {
      line,
      error: `a plain \`${text}\` is read by YAML as ${implicit}, not as a string: quote it`,
    };
  }
  if (PLAIN_INDICATORS.test(text) || /^[-?:](\s|$)/.test(text)) {
    return {
      line,
      error: `a plain value cannot begin with \`${text[0]}\`: quote it, or an installer reads it as YAML structure`,
    };
  }
  const bad = PLAIN_STRUCTURE.exec(text);
  if (bad) {
    return {
      line,
      error: `a plain value holds \`${bad[0].trim() || ':'}\`, which YAML reads as structure and an installer rejects: quote the value, or fold it with \`>-\``,
    };
  }
  return { line, value: text };
}

/** What YAML's core schema makes of an unquoted scalar that is not text, or nothing. */
function nonString(text) {
  if (/^(~|null|Null|NULL)$/.test(text)) return 'null';
  if (/^(true|True|TRUE|false|False|FALSE)$/.test(text)) return 'a boolean';
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(text)) return 'a number';
  if (/^(0x[0-9a-fA-F]+|0o[0-7]+)$/.test(text)) return 'a number';
  if (/^([-+]?\.(inf|Inf|INF)|\.(nan|NaN|NAN))$/.test(text)) return 'a number';
  return null;
}

function quoted(rest, continuation, mark, line) {
  const joined = [rest, ...continuation.filter((t) => t !== '')].join(' ').trim();
  if (joined.length < 2 || !joined.endsWith(mark)) {
    return { line, error: `the ${mark}-quoted value is never closed` };
  }
  const inner = joined.slice(1, -1);
  if (mark === "'") {
    if (inner.replace(/''/g, '').includes("'")) {
      return { line, error: 'a single quote inside a single-quoted value must be doubled' };
    }
    return { line, value: inner.replace(/''/g, "'") };
  }
  try {
    return { line, value: JSON.parse(joined) };
  } catch (e) {
    return { line, error: `the double-quoted value does not parse: ${e.message}` };
  }
}

function blockScalar([, style, a, , b], body) {
  const chomp = (a + b).includes('-') ? 'strip' : (a + b).includes('+') ? 'keep' : 'clip';
  const lines = body.map((l) => l.text);
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  const indent = Math.min(
    ...lines.filter((l) => l.trim() !== '').map((l) => /^\s*/.exec(l)[0].length),
  );
  const rows = lines.map((l) =>
    l.trim() === '' ? '' : l.slice(Number.isFinite(indent) ? indent : 0),
  );
  let text;
  if (style === '|') {
    text = rows.join('\n');
  } else {
    // Folded: a line break between two text lines is a space, and a blank line is a line break.
    text = '';
    for (let i = 0; i < rows.length; i++) {
      if (i > 0) text += rows[i] === '' || rows[i - 1] === '' || /^\s/.test(rows[i]) ? '\n' : ' ';
      text += rows[i];
    }
    text = text.replace(/\n\n/g, '\n');
  }
  if (chomp === 'strip' || rows.length === 0) return text;
  return `${text}\n`;
}

/**
 * Every way `raw`, the text of the SKILL.md in a directory named `directory`, is one an installer
 * enforcing the spec rejects, as `{ field, rule, measured, limit }` — what was wrong, the value
 * measured, and the limit it broke. None means the skill is offered.
 */
export function skillFaults(raw, directory) {
  const parsed = parseFrontmatter(raw);
  if (parsed.error) {
    return [
      {
        field: 'frontmatter',
        rule: parsed.error,
        measured: `line ${parsed.line}`,
        limit: 'a `---` fenced block of `key: value` lines',
      },
    ];
  }
  const faults = [];
  const take = (key) => {
    const f = parsed.fields.get(key);
    if (f === undefined) {
      faults.push({ field: key, rule: 'is absent', measured: 'no such key', limit: 'required' });
      return null;
    }
    if (f.error) {
      faults.push({
        field: key,
        rule: f.error,
        measured: `line ${f.line}`,
        limit: 'a string an installer can read',
      });
      return null;
    }
    return f.value;
  };

  const name = take('name');
  if (name !== null) faults.push(...nameFaults(name, directory));
  const description = take('description');
  if (description !== null) faults.push(...descriptionFaults(description));
  return faults;
}

function nameFaults(name, directory) {
  const faults = [];
  const fault = (rule, measured, limit) => faults.push({ field: 'name', rule, measured, limit });
  if (name.trim() === '') {
    fault('is empty', 'an empty value', `1 to ${NAME_LIMIT} characters`);
    return faults;
  }
  if (name.length > NAME_LIMIT) {
    fault('is too long', `${name.length} characters`, `at most ${NAME_LIMIT}`);
  }
  const outside = [...new Set(name.match(/[^a-z0-9-]/g) ?? [])];
  if (outside.length > 0) {
    fault(
      'holds a character outside lowercase letters, digits and hyphens',
      outside.map((c) => JSON.stringify(c)).join(' '),
      '[a-z0-9-]',
    );
  }
  if (/^-|-$|--/.test(name)) {
    fault(
      'begins or ends with a hyphen, or holds two in a row',
      JSON.stringify(name),
      'single hyphens between words',
    );
  }
  if (name !== directory) {
    fault(
      'differs from the directory the skill sits in',
      JSON.stringify(name),
      `the directory name \`${directory}\``,
    );
  }
  return faults;
}

function descriptionFaults(description) {
  const faults = [];
  const fault = (rule, measured, limit) =>
    faults.push({ field: 'description', rule, measured, limit });
  if (description.trim() === '') {
    fault('is empty', 'an empty value', `1 to ${DESCRIPTION_LIMIT} characters`);
    return faults;
  }
  if (description.length > DESCRIPTION_LIMIT) {
    fault('is too long', `${description.length} characters`, `at most ${DESCRIPTION_LIMIT}`);
  }
  const tags = [...new Set(description.match(PLACEHOLDER) ?? [])];
  if (tags.length > 0) {
    fault(
      'holds an angle-bracket placeholder, which an installer reads as markup',
      tags.join(' '),
      'no `<word>` in a description',
    );
  }
  const hidden = [...new Set(unprintable(description))];
  if (hidden.length > 0) {
    fault(
      'holds a character no YAML stream may carry',
      hidden
        .map((c) => `U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`)
        .join(' '),
      'printable characters, the tab and the newline',
    );
  }
  return faults;
}
