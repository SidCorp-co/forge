import type { KnowledgeRefusalCode } from '@forge/contracts/knowledge';
import { type IssueStatus, issueStatuses } from '../db/schema.js';
import { type MasterVerb, masterVerbs } from '../db/schema-master-charter.js';
import { type RefusalError, refuser } from '../lib/refusal.js';

const refuse = refuser<KnowledgeRefusalCode>('KNOWLEDGE_REFUSED');

/** When an entry is worth reading — the verb a master is performing or the board state it is
 *  looking at, never a file glob — a second axis beside `injection` (ISS-1313). */
export interface ReadWhenCondition {
  verbs?: MasterVerb[];
  statuses?: IssueStatus[];
}

export interface ReadWhenRefusal {
  field: string;
  message: string;
}

export type ParsedReadWhen =
  | { ok: true; value: ReadWhenCondition | null }
  | { ok: false; refusal: ReadWhenRefusal };

/** The keys a condition is refused by name for carrying — a condition is a verb or a board
 *  state, never a file glob, and these are the shapes a glob is spelled with elsewhere in
 *  this codebase. */
const READ_WHEN_GLOB_KEYS = ['glob', 'globs', 'paths', 'files', 'pattern'] as const;

function isPlainObject(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw);
}

const refuseReadWhen = (field: string, message: string): ParsedReadWhen => ({
  ok: false,
  refusal: { field, message },
});

/**
 * Parse a knowledge entry's `readWhen`. `undefined` and `null` both parse to
 * `{ ok: true, value: null }` — "names no condition" — and it is the CALLER's
 * job to tell "the field was absent" from "the field was sent as `null`"
 * before this runs, because those two mean different things to an upsert
 * (leave the stored condition alone vs. remove it) and only one of them means
 * anything here.
 */
export function parseReadWhen(raw: unknown): ParsedReadWhen {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (!isPlainObject(raw)) {
    return refuseReadWhen(
      'readWhen',
      '`readWhen` is an object naming when this entry is worth reading — `{ verbs?: string[], statuses?: string[] }` — and this one is not an object.',
    );
  }

  const globKey = READ_WHEN_GLOB_KEYS.find((k) => k in raw);
  if (globKey) {
    return refuseReadWhen(
      globKey,
      `a knowledge entry's condition is the verb a master is performing or the board state it is looking at, and never a file glob. \`${globKey}\` names one; remove it and use \`verbs\` or \`statuses\` instead.`,
    );
  }

  const extra = Object.keys(raw).filter((k) => k !== 'verbs' && k !== 'statuses');
  if (extra.length > 0) {
    return refuseReadWhen(
      extra[0] ?? 'readWhen',
      `\`readWhen\` carries only \`verbs\` and \`statuses\`. This one also carries \`${extra[0]}\`, which a condition has no field for.`,
    );
  }

  const verbsRaw = raw.verbs;
  const statusesRaw = raw.statuses;
  if (verbsRaw === undefined && statusesRaw === undefined) {
    return refuseReadWhen(
      'readWhen',
      'a condition names the master verb being performed, the board status being looked at, or both — and this one names neither, so it would match nothing that ever reads it.',
    );
  }

  let verbs: MasterVerb[] | undefined;
  if (verbsRaw !== undefined) {
    if (!Array.isArray(verbsRaw)) {
      return refuseReadWhen(
        'verbs',
        '`verbs` is an array of master verbs, and this one is not an array.',
      );
    }
    if (verbsRaw.length === 0) {
      return refuseReadWhen(
        'verbs',
        '`verbs` is empty, which is a condition that matches no verb a master ever performs — an entry named on no axis worth having is the same defect as naming neither axis at all. Name at least one verb, or omit `verbs` entirely.',
      );
    }
    for (const v of verbsRaw) {
      if (typeof v !== 'string' || !(masterVerbs as readonly string[]).includes(v)) {
        return refuseReadWhen(
          'verbs',
          `\`verbs\` names "${String(v)}", which is not a verb a master performs. Valid verbs: ${masterVerbs.join(', ')}.`,
        );
      }
    }
    verbs = verbsRaw as MasterVerb[];
  }

  let statuses: IssueStatus[] | undefined;
  if (statusesRaw !== undefined) {
    if (!Array.isArray(statusesRaw)) {
      return refuseReadWhen(
        'statuses',
        '`statuses` is an array of issue statuses, and this one is not an array.',
      );
    }
    if (statusesRaw.length === 0) {
      return refuseReadWhen(
        'statuses',
        '`statuses` is empty, which is a condition that matches no board state — the same defect as naming neither axis at all. Name at least one status, or omit `statuses` entirely.',
      );
    }
    for (const s of statusesRaw) {
      if (typeof s !== 'string' || !(issueStatuses as readonly string[]).includes(s)) {
        return refuseReadWhen(
          'statuses',
          `\`statuses\` names "${String(s)}", which is not an issue status. Valid statuses: ${issueStatuses.join(', ')}.`,
        );
      }
    }
    statuses = statusesRaw as IssueStatus[];
  }

  return { ok: true, value: { ...(verbs ? { verbs } : {}), ...(statuses ? { statuses } : {}) } };
}

/** The refusal `upsertKnowledgeEntries` throws for a `readWhen` that does not parse, never trimmed or guessed. */
export function readWhenRefusal(refusal: ReadWhenRefusal): RefusalError {
  const at = refusal.field.startsWith('readWhen') ? refusal.field : `readWhen.${refusal.field}`;
  return refuse('KNOWLEDGE_READ_WHEN_SHAPE', refusal.message, `/${at.split('.').join('/')}`);
}
