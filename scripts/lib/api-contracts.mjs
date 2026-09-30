// The verdict half of check-api-contracts: given the committed artifact text and the text the
// generator just wrote, name every route or tool that differs. The CLI spawns and reads files.

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function pointerPart(key) {
  return String(key).replaceAll('~', '~0').replaceAll('/', '~1');
}

/** The first JSON pointer, in key order, at which two values stop agreeing; null when equal. */
export function firstDifference(a, b, at = '') {
  if (Object.is(a, b)) return null;
  const bothObjects = a !== null && b !== null && typeof a === 'object' && typeof b === 'object';
  if (!bothObjects || Array.isArray(a) !== Array.isArray(b)) return at || '/';
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    if (!(key in a) || !(key in b)) return `${at}/${pointerPart(key)}`;
    const found = firstDifference(a[key], b[key], `${at}/${pointerPart(key)}`);
    if (found !== null) return found;
  }
  return null;
}

function parsed(label, text) {
  if (text === null) return { error: `${label} is absent` };
  try {
    return { value: JSON.parse(text) };
  } catch (err) {
    return { error: `${label} is not JSON: ${err.message}` };
  }
}

function operations(doc) {
  const out = new Map();
  for (const [path, item] of Object.entries(doc?.paths ?? {})) {
    for (const method of METHODS) {
      if (item?.[method] !== undefined) out.set(`${method.toUpperCase()} ${path}`, item[method]);
    }
  }
  return out;
}

function tools(doc) {
  return new Map((doc?.tools ?? []).map((t) => [t?.name, t]));
}

function withoutMembers(doc, field) {
  const { [field]: _members, ...rest } = doc ?? {};
  return rest;
}

function memberFindings(kind, committed, generated) {
  const findings = [];
  for (const [name, entry] of generated) {
    if (!committed.has(name)) {
      findings.push(`${kind} ${name}: served by the code, absent from the committed contract`);
      continue;
    }
    const at = firstDifference(committed.get(name), entry);
    if (at !== null) findings.push(`${kind} ${name}: differs from the committed contract at ${at}`);
  }
  for (const name of committed.keys()) {
    if (!generated.has(name)) {
      findings.push(`${kind} ${name}: in the committed contract, no longer served by the code`);
    }
  }
  return findings;
}

/**
 * Compare one artifact. `members` reads the named entries (routes or tools) out of a parsed
 * document, and `field` is the member container, so a difference outside every member is still
 * named rather than folded into a byte mismatch nobody can place.
 */
export function artifactDrift({ label, kind, field, members }, committedText, generatedText) {
  if (committedText === generatedText) return { findings: [] };
  const generated = parsed(`the generated ${label}`, generatedText);
  if (generated.error) return { unusable: generated.error };
  const committed = parsed(label, committedText);
  if (committed.error) return { findings: [committed.error] };
  const findings = memberFindings(kind, members(committed.value), members(generated.value));
  const outside = firstDifference(
    withoutMembers(committed.value, field),
    withoutMembers(generated.value, field),
  );
  if (outside !== null) findings.push(`${label}: differs outside every ${kind} at ${outside}`);
  if (findings.length === 0) {
    findings.push(
      `${label}: every ${kind} matches, yet the bytes differ — the file was not written by the generator`,
    );
  }
  return { findings };
}

export const API = {
  label: 'packages/core/contracts/forge-api.openapi.json',
  kind: 'route',
  field: 'paths',
  members: operations,
};

export const MCP = {
  label: 'packages/core/contracts/forge-mcp.tools.json',
  kind: 'tool',
  field: 'tools',
  members: tools,
};

/** How many members a generated artifact holds, for the scan line. */
export function memberCount(spec, generatedText) {
  const generated = parsed(spec.label, generatedText);
  return generated.error ? null : spec.members(generated.value).size;
}
