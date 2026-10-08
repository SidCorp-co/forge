// What a held chat write would record, in the words its confirm card shows: a heading, the lines a
// person reads before agreeing, and the records it links to (REQ-30 BC-4 names "which existing
// requirement, feedback or design it relates to"). Read from the call itself, so what is shown is
// what core will write: an Assistant tool call, or an Agent session's REST request.

import type { ChatProposalKind, ChatProposalSummary } from '@forge/contracts/chat-proposals';

const LINE_MAX = 300;
const LISTED_LINES = 12;

type Args = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const clip = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > LINE_MAX ? `${flat.slice(0, LINE_MAX - 1)}…` : flat;
};

function parsed(json: string): Args {
  try {
    const v = JSON.parse(json) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Args) : {};
  } catch {
    return {};
  }
}

const argvOf = (args: Args): string[] =>
  Array.isArray(args.argv) ? args.argv.filter((a): a is string => typeof a === 'string') : [];

/** The kind of record an Assistant write tool call makes; every call `isWriteCall` marks has one. */
export function kindOfToolCall(name: string, argsJson: string): ChatProposalKind {
  switch (name) {
    case 'forge_feedback':
      return 'feedback';
    case 'forge_requirement_draft':
      return 'requirement_draft';
    case 'forge_requirement_revise':
      return 'requirement_revision';
    case 'forge_memory_note':
      return 'memory_note';
    case 'forge_preferences':
      return 'preferences';
    case 'forge_template_save':
      return 'report_save';
    case 'forge': {
      const verb = argvOf(parsed(argsJson))[0];
      if (verb === 'comment') return 'comment';
      if (verb === 'attach') return 'attachment';
      if (verb === 'issue') return 'issue_change';
      break;
    }
  }
  throw new Error(
    `chat agreement: ${name} ${argsJson.slice(0, 120)} is a write the agreement gate holds, and no kind of record names it; add it to kindOfToolCall`,
  );
}

/** Feedback's one target, as its link reads. */
function feedbackTarget(args: Args): string[] {
  for (const field of ['requirement', 'issue', 'release', 'workflow', 'endpoint', 'screen']) {
    const v = str(args[field]);
    if (v) return [field === 'requirement' || field === 'issue' ? v : `${field} ${v}`];
  }
  return [];
}

function feedbackSummary(args: Args): ChatProposalSummary {
  const lines = [str(args.body), str(args.whereSeen) && `Where seen: ${str(args.whereSeen)}`]
    .filter((l): l is string => !!l)
    .map(clip);
  return {
    title: `Feedback (${str(args.kind) ?? 'unknown kind'}): ${str(args.title) ?? 'untitled'}`,
    lines,
    relates: feedbackTarget(args),
  };
}

function criteriaLines(args: Args): string[] {
  const criteria = Array.isArray(args.criteria) ? args.criteria : [];
  const bodies = criteria
    .map((c) => str((c as Args | null)?.body))
    .filter((b): b is string => !!b)
    .map(clip);
  const from = args.criteriaFrom as Args | undefined;
  const fromLine = str(from?.file)
    ? [
        `Criteria from ${str(from?.file)}${str(from?.section) ? `, section "${str(from?.section)}"` : ''}`,
      ]
    : [];
  const listed = bodies.slice(0, LISTED_LINES);
  const more = bodies.length > LISTED_LINES ? [`and ${bodies.length - LISTED_LINES} more`] : [];
  return [...fromLine, ...listed, ...more];
}

function requirementSummary(kind: ChatProposalKind, args: Args, ref: string | null) {
  const reason = str(args.reason);
  const designs = Array.isArray(args.designs)
    ? args.designs.filter((d): d is string => typeof d === 'string').map((d) => `design ${d}`)
    : [];
  const title =
    kind === 'requirement_draft'
      ? `New requirement: ${str(args.title) ?? 'untitled'}`
      : `Revision of ${ref ?? 'a requirement'}`;
  return {
    title,
    lines: [...(reason ? [`Why: ${clip(reason)}`] : []), ...criteriaLines(args)],
    relates: [...(ref ? [ref] : []), ...designs],
  };
}

const KEY_RE = /\b(?:[A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

function noteSummary(text: string | null, title: string | null): ChatProposalSummary {
  return {
    title: `Remember: ${title ?? clip(text ?? '').slice(0, 80)}`,
    lines: text ? [clip(text)] : [],
    relates: [...new Set(text?.match(KEY_RE) ?? [])],
  };
}

function cliSummary(kind: ChatProposalKind, args: Args): ChatProposalSummary {
  const argv = argvOf(args);
  const body = str(args.body);
  if (kind === 'comment') {
    const target = argv[1] ?? 'an issue';
    return { title: `Comment on ${target}`, lines: body ? [clip(body)] : [], relates: [target] };
  }
  if (kind === 'attachment') {
    const rest = argv.slice(1);
    const target = rest[0] === 'issue' ? (rest[1] ?? 'an issue') : (rest[0] ?? 'an issue');
    const files = rest.slice(rest[0] === 'issue' ? 2 : 1).map((p) => p.split('/').pop() ?? p);
    return { title: `Attach to ${target}`, lines: files, relates: [target] };
  }
  const target = argv[1] ?? 'an issue';
  return { title: `Change ${target}`, lines: [argv.slice(2).join(' ')], relates: [target] };
}

/** What an Assistant write tool call would record. */
export function summaryOfToolCall(
  kind: ChatProposalKind,
  name: string,
  argsJson: string,
): ChatProposalSummary {
  const args = parsed(argsJson);
  switch (kind) {
    case 'feedback':
      return feedbackSummary(args);
    case 'requirement_draft':
      return requirementSummary(kind, args, null);
    case 'requirement_revision':
      return requirementSummary(kind, args, str(args.requirement));
    case 'memory_note':
      return noteSummary(str(args.text), str(args.title));
    case 'preferences':
      return {
        title: 'Your reply preferences',
        lines: [
          ...(str(args.answerStyle) ? [`Reply style: ${str(args.answerStyle)}`] : []),
          ...(args.assistantInstructions === null ? ['Clear your standing instructions'] : []),
          ...(str(args.assistantInstructions)
            ? [`Standing instructions: ${clip(str(args.assistantInstructions) ?? '')}`]
            : []),
        ],
        relates: [],
      };
    case 'report_save':
      return {
        title: `Save the report ${str(args.templateId) ?? ''}`.trim(),
        lines: [],
        relates: [],
      };
    default:
      if (name !== 'forge') throw new Error(`chat agreement: ${name} is not a ${kind} tool`);
      return cliSummary(kind, args);
  }
}

/** The record a REST path names: `/api/issues/<ref>/…`, or a project's requirement, feedback or workflow. */
function pathTarget(path: string): string | null {
  const issue = /^\/api\/issues\/([^/]+)\//.exec(path);
  if (issue?.[1]) return decodeURIComponent(issue[1]);
  const item = /^\/api\/projects\/[^/]+\/(requirements|feedback|workflows|issues)\/([^/]+)\//.exec(
    path,
  );
  if (!item?.[2]) return null;
  const ref = decodeURIComponent(item[2]);
  return item[1] === 'workflows' ? `design ${ref}` : ref;
}

/**
 * What an Agent session's held REST request would record. `body` is its bytes; `attachmentName`
 * is the file a multipart attachment carries, read by the hold that parsed it.
 */
export function summaryOfRest(
  kind: ChatProposalKind,
  path: string,
  body: Args,
  attachmentName: string | null,
): ChatProposalSummary {
  const target = pathTarget(path);
  switch (kind) {
    case 'feedback':
      return feedbackSummary(body);
    case 'requirement_draft':
      return requirementSummary(kind, body, null);
    case 'requirement_revision':
      return requirementSummary(kind, body, target);
    case 'memory_note':
      return noteSummary(str(body.textContent), str((body.metadata as Args | undefined)?.title));
    case 'comment':
      return {
        title: `Comment on ${target ?? 'a record'}`,
        lines: str(body.body) ? [clip(str(body.body) ?? '')] : [],
        relates: target ? [target] : [],
      };
    case 'attachment':
      return {
        title: `Attach to ${target ?? 'a record'}`,
        lines: [attachmentName ?? str(body.name) ?? 'a file'],
        relates: target ? [target] : [],
      };
    default:
      return { title: `${kind.replace('_', ' ')} on ${target ?? path}`, lines: [], relates: [] };
  }
}

/** The record's key a write answered with, read from what the write returned. */
export function recordRefOf(kind: ChatProposalKind, answered: Args): string | null {
  const nested = (key: string) => str((answered[key] as Args | undefined)?.key);
  switch (kind) {
    case 'feedback':
      return nested('feedback') ?? str(answered.key);
    case 'requirement_draft':
    case 'requirement_revision': {
      const key = nested('requirement') ?? str(answered.key);
      const revisions = (answered.revisions ??
        (answered.requirement as Args | undefined)?.revisions) as Args[] | undefined;
      const latest = Array.isArray(revisions) ? revisions.at(-1)?.revision : undefined;
      return key && kind === 'requirement_revision' && typeof latest === 'number'
        ? `${key} r${latest}`
        : key;
    }
    default:
      return str(answered.key) ?? str(answered.id);
  }
}
