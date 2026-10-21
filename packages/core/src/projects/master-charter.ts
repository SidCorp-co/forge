/**
 * The shape of a project's master charter, and the sentence each wrong shape is
 * refused with (ISS-1313).
 *
 * A charter is written by a person and read by a master, so every refusal here
 * names the field that was wrong and the shape that would be right. Nothing is
 * trimmed into validity, nothing is coerced and nothing is dropped: a rule that
 * is only whitespace is refused where it stands rather than quietly removed,
 * because a list a person sent and a list the store holds that differ by one
 * line is the silent substitution this whole record exists to stop.
 */

import { fieldsNear } from '../lib/zod-sentences.js';

export const MASTER_CHARTER_GOAL_MAX = 4000;
export const MASTER_CHARTER_RULES_MAX = 50;
export const MASTER_CHARTER_RULE_MAX = 2000;

/** The path a `master.wake` frame points a master at. */
export function masterCharterPath(projectId: string): string {
  return `/api/projects/${projectId}/master-charter`;
}

export const MASTER_CHARTER_IS_A_PERSONS_WRITE =
  'a master charter is written by a person and read by a master. This request arrived on an agent credential, so it is refused: a standing goal an agent can edit is a job description the agent can talk itself out of. Write it from a signed-in session, or from a token belonging to a person.';

export interface MasterCharterWrite {
  goal: string;
  rules: string[];
}

export interface CharterRefusal {
  field: string;
  message: string;
}

export type ParsedCharterWrite =
  | { ok: true; value: MasterCharterWrite }
  | { ok: false; refusal: CharterRefusal };

const CHARTER_FIELDS = ['goal', 'rules'];

const SHAPE =
  'a master charter write is `{ "goal": "<one sentence or more>", "rules": ["<rule>", ...] }`';

function listed(names: readonly string[]): string {
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function refuse(field: string, message: string): ParsedCharterWrite {
  return { ok: false, refusal: { field, message } };
}

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

export function parseMasterCharterWrite(raw: unknown): ParsedCharterWrite {
  if (!isPlainObject(raw)) {
    return refuse('body', `${SHAPE}, and this body is not an object at all.`);
  }

  const extra = Object.keys(raw).filter((k) => !CHARTER_FIELDS.includes(k));
  if (extra.length > 0) {
    // A slip of case or a letter ("Rules", "gaol") is pointed at the field it was (ISS-1421 r18).
    const meant = extra.flatMap((k) =>
      fieldsNear(k, CHARTER_FIELDS).map(
        (f) => ` This call takes \`${f}\`, which may be what \`${k}\` meant.`,
      ),
    );
    return refuse(
      extra[0] ?? 'body',
      (extra.length === 1
        ? `${SHAPE}. This body also carries \`${extra[0]}\`, which a charter has no field for. Remove it rather than have it stored under a name nothing reads.`
        : `${SHAPE}. This body also carries ${listed(extra.map((k) => `\`${k}\``))}, which a charter has no fields for. Remove them rather than have them stored under names nothing reads.`) +
        meant.join(''),
    );
  }

  const goal = raw.goal;
  if (typeof goal !== 'string') {
    return refuse(
      'goal',
      `\`goal\` is the one sentence saying what this project's master is for, and it must be a string. This one is ${goal === undefined ? 'absent' : `a ${Array.isArray(goal) ? 'array' : typeof goal}`}. ${SHAPE}.`,
    );
  }
  if (goal.trim().length === 0) {
    return refuse(
      'goal',
      '`goal` is empty, or holds nothing but whitespace. A project that means to declare no goal declares no charter at all; it is not declared by sending a blank one, and a blank one is not trimmed into an absent one here.',
    );
  }
  if (goal.length > MASTER_CHARTER_GOAL_MAX) {
    return refuse(
      'goal',
      `\`goal\` is ${goal.length} characters and the limit is ${MASTER_CHARTER_GOAL_MAX}. A standing goal a master reads at the start of every pass is a paragraph, not a document; what will not fit belongs in a rule or in the project's knowledge store.`,
    );
  }

  const rules = raw.rules;
  if (!Array.isArray(rules)) {
    return refuse(
      'rules',
      `\`rules\` is an array of strings, one rule per entry, and may be empty. This one is ${rules === undefined ? 'absent' : `a ${typeof rules}`} — a single rule still travels as \`["<rule>"]\`, and a string here is not read as a list of one. ${SHAPE}.`,
    );
  }
  if (rules.length > MASTER_CHARTER_RULES_MAX) {
    return refuse(
      'rules',
      `\`rules\` carries ${rules.length} entries and the limit is ${MASTER_CHARTER_RULES_MAX}. A list longer than that is not read by anybody it binds.`,
    );
  }

  for (const [i, rule] of rules.entries()) {
    if (typeof rule !== 'string') {
      return refuse(
        `rules[${i}]`,
        `\`rules[${i}]\` is a ${rule === null ? 'null' : Array.isArray(rule) ? 'array' : typeof rule}, and every rule is a string.`,
      );
    }
    if (rule.trim().length === 0) {
      return refuse(
        `rules[${i}]`,
        `\`rules[${i}]\` is empty, or holds nothing but whitespace. It is refused where it stands rather than dropped from the list: a charter that comes back one rule shorter than it was sent is a charter nobody can trust.`,
      );
    }
    if (rule.length > MASTER_CHARTER_RULE_MAX) {
      return refuse(
        `rules[${i}]`,
        `\`rules[${i}]\` is ${rule.length} characters and the limit is ${MASTER_CHARTER_RULE_MAX}. A rule that long is a document; give it a slug in the project's knowledge store and name it from a rule here.`,
      );
    }
  }

  return { ok: true, value: { goal, rules: rules as string[] } };
}
