// Mode-qualification rule for the docs injected into every agent session.
//
// A guide body and a `tier: 'mandatory'` fact are read by agents on EVERY
// project, and the fleet is not all one pipeline mode. So a sentence naming a
// status transition is a mode-specific claim: `waiting → approved` is the
// staged answer, and on an autonomous project the driver can write neither
// status. The rule is therefore not "never name these statuses" — a global doc
// must be able to describe staged — but "name the mode you mean".
//
// Split from the CLI so the verdict is testable: the CLI reads the tree and
// exits, neither of which a test can call.

const TRANSITION_VERB =
  /\b(approv\w*|mov\w*|park\w*|cascad\w*|promot\w*|re-enter\w*|transition\w*|advanc\w*|revert\w*|set)\b/i;

const MODE_NAMES = ['staged', 'autonomous'];

/** Statuses named on a line that renders from project data are the project's own, not a claim. */
const PROJECT_RESOLVED = /\$\{/;

function statusAlternation(statuses) {
  return statuses.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
}

/**
 * Template-literal bodies, unescaped, with the line number each started on so a
 * violation points at the source file rather than at an offset inside a string.
 * `openers` are regex sources, because the mandatory tier is reached through a
 * `render: () => CONST` indirection and only the `export const` holds the text.
 */
export function extractBodies(src, openers) {
  const bodies = [];
  for (const opener of openers) {
    const re = new RegExp(`${opener}\\s*\``, 'g');
    for (let m = re.exec(src); m !== null; m = re.exec(src)) {
      const start = m.index + m[0].length;
      let body = '';
      for (let i = start; i < src.length; i++) {
        if (src[i] === '`' && src[i - 1] !== '\\') break;
        body += src[i];
      }
      bodies.push({
        startLine: src.slice(0, start).split('\n').length,
        text: body.replace(/\\`/g, '`'),
      });
    }
  }
  return bodies;
}

export function isModeQualified(line) {
  return MODE_NAMES.some((m) => line.includes(m));
}

/**
 * Transitions on one line whose target the driver of an unnamed mode could not
 * write. `paired` (`a → b`) is a transition by shape alone; `directed` (`→ b`)
 * needs a verb on the line, which is what keeps "record it → `draft`" — a
 * create-time choice, not a transition — out of the result.
 */
export function transitionsOnLine(line, allStatuses, driverStatuses) {
  if (PROJECT_RESOLVED.test(line)) return [];
  const alt = statusAlternation(allStatuses);
  const bare = line.replace(/`/g, '');
  const found = [];

  const paired = new RegExp(`\\b(${alt})\\b\\s*(?:→|->)\\s*\\b(${alt})\\b`, 'g');
  for (const m of bare.matchAll(paired)) found.push({ from: m[1], to: m[2], form: 'paired' });

  if (TRANSITION_VERB.test(line)) {
    const directed = new RegExp(`(?:→|->)\\s*\`(${alt})\``, 'g');
    for (const m of line.matchAll(directed)) {
      if (found.some((f) => f.to === m[1])) continue;
      found.push({ from: null, to: m[1], form: 'directed' });
    }
  }
  return found.filter((t) => !driverStatuses.includes(t.to));
}

/**
 * @returns {{ violations: Array, transitionsChecked: number }} every transition
 * the rule examined, so a caller can fail closed when extraction found none.
 */
export function checkSurface(surface, allStatuses, driverStatuses) {
  const violations = [];
  let transitionsChecked = 0;
  for (const body of surface.bodies) {
    body.text.split('\n').forEach((line, i) => {
      const hits = transitionsOnLine(line, allStatuses, driverStatuses);
      transitionsChecked += hits.length;
      if (hits.length === 0 || isModeQualified(line)) return;
      for (const t of hits) {
        violations.push({
          file: surface.file,
          line: body.startLine + i,
          from: t.from,
          to: t.to,
          form: t.form,
          text: line.trim(),
        });
      }
    });
  }
  return { violations, transitionsChecked };
}
