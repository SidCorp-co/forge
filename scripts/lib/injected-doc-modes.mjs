// Mode-qualification rules for the docs injected into every agent session.
//
// A guide body and a `tier: 'mandatory'` fact are read by agents on EVERY
// project, and the fleet is not all one pipeline mode. So a sentence naming a
// status transition is a mode-specific claim: `waiting → approved` is the
// staged answer, and on an autonomous project the driver can write neither
// status. The rule is therefore not "never name these statuses" — a global doc
// must be able to describe staged — but "name the mode you mean".
//
//   R1  a status transition whose target is outside the driver's vocabulary
//   R2  a STEP named as the actor of something the reader is told about
//
// R2 exists because R1 read green over the claim that actually cost the most:
// `those are written by the clarify/plan steps` carries no transition at all,
// and an autonomous project has neither step. ISS-874 burned ~450 messages and
// 3 dispatches across four sessions on that shape.
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

const STEP_NOUN = '(?:steps?|stages?|phases?)';

/** `written by the clarify/plan steps` — the step is the agent of the claim. */
const AGENT_OF = /\b(?:written|owned|set|filled|decided|declared|produced|authored)\s+by\b/i;

/** `the plan step exists to decide` — the step is the subject, verb adjacent. */
const ACTIVE_VERB = '(?:declares?|owns?|writes?|decides?|produces?|sets?|exists?\\s+to)';

// cm:guard the two shapes above are the WHOLE rule, and widening them is what turns this gate off. Measured on this tree: a bare active verb anywhere in the sentence flags `On a review or test step that rejects … after your write` (`write`), and a possessive flags `the release stage's human-confirm gate` — two lines whose correct fix is NO CHANGE, so the only way to silence the gate is to add a mode name that makes the doc say something false. A rule whose fix makes the doc worse gets waived, not obeyed.
function namesStepAsActor(sentence, alt) {
  const adjacent = new RegExp(`\\b(?:${alt})\\s+${STEP_NOUN}\\s+${ACTIVE_VERB}\\b`, 'i');
  return AGENT_OF.test(sentence) || adjacent.test(sentence);
}

/**
 * Sentences, with a char→line map, because prose in these docs WRAPS: the
 * ISS-874 claim straddles two physical lines (`… written by the` / `clarify and
 * plan steps …`), which a per-line scan reads as an agent and a step that never
 * meet. A markdown table row stands alone — rows are independent claims, and
 * joining them lets one row's mode name silence its neighbours.
 */
export function sentencesOf(text) {
  const src = text.split('\n');
  const isRow = (l) => l.trimStart().startsWith('|');
  const out = [];
  for (let p = 0; p < src.length; p++) {
    if (src[p].trim() === '') continue;
    let joined = '';
    const at = [];
    let q = p;
    do {
      if (joined !== '') {
        joined += ' ';
        at.push(q);
      }
      for (const ch of src[q].trim()) {
        joined += ch;
        at.push(q);
      }
      q++;
    } while (!isRow(src[p]) && q < src.length && src[q].trim() !== '' && !isRow(src[q]));
    p = q - 1;

    let start = 0;
    const ends = [...joined.matchAll(/[.;!?](?=\s|$)/g)].map((m) => m.index + 1);
    ends.push(joined.length);
    for (const end of ends) {
      if (end <= start) continue;
      if (joined.slice(start, end).trim() !== '') {
        out.push({ text: joined.slice(start, end), at: at.slice(start, end) });
      }
      start = end;
    }
  }
  return out;
}

/**
 * Step names claimed as the actor in one sentence, when the step belongs to a
 * mode the sentence does not name. Staged and autonomous share NO step name, so
 * every such claim is mode-specific — but only the actor shape is reported; a
 * step mentioned as a place or a condition is not a claim about the reader.
 */
export function stepClaimsInSentence(sentence, stepNames) {
  if (PROJECT_RESOLVED.test(sentence)) return [];
  const alt = statusAlternation(stepNames);
  const bare = sentence.replace(/`/g, '');
  const re = new RegExp(
    `\\b((?:${alt})(?:\\s*(?:,|and|or|/)\\s*(?:${alt}))*)\\s+${STEP_NOUN}\\b`,
    'gi',
  );
  const found = [...bare.matchAll(re)].map((m) => ({ steps: m[1], index: m.index }));
  if (found.length === 0 || !namesStepAsActor(bare, alt)) return [];
  return found;
}

/**
 * @returns {{ violations: Array, transitionsChecked: number, stepClaimsChecked: number }}
 * every transition AND every step claim the rules examined, so a caller can
 * fail closed when either extraction found none.
 */
export function checkSurface(surface, { allStatuses, driverStatuses, stepNames }) {
  const violations = [];
  let transitionsChecked = 0;
  let stepClaimsChecked = 0;
  for (const body of surface.bodies) {
    body.text.split('\n').forEach((line, i) => {
      const hits = transitionsOnLine(line, allStatuses, driverStatuses);
      transitionsChecked += hits.length;
      if (hits.length === 0 || isModeQualified(line)) return;
      for (const t of hits) {
        violations.push({
          rule: 'R1',
          file: surface.file,
          line: body.startLine + i,
          from: t.from,
          to: t.to,
          form: t.form,
          text: line.trim(),
        });
      }
    });

    for (const sentence of sentencesOf(body.text)) {
      const claims = stepClaimsInSentence(sentence.text, stepNames);
      stepClaimsChecked += claims.length;
      if (claims.length === 0 || isModeQualified(sentence.text)) continue;
      for (const c of claims) {
        violations.push({
          rule: 'R2',
          file: surface.file,
          line: body.startLine + (sentence.at[c.index] ?? 0),
          steps: c.steps,
          text: sentence.text.trim(),
        });
      }
    }
  }
  return { violations, transitionsChecked, stepClaimsChecked };
}
