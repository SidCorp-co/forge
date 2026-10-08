// What a held chat write would record, in the words its confirm card shows: a heading, the lines a
// person reads before agreeing, and the records it links to (REQ-30 BC-4 names "which existing
// requirement, feedback or design it relates to"). Read from the call itself, so what is shown is
// what core will write: an Assistant tool call, or an Agent session's REST request.
//
// The card shows the WHOLE proposal (ISS-439, the judge's finding that a card showing three lines
// had a person agree to criteria they never saw): every field the call carries is a line, none is
// clipped and no list is cut short. A field this file does not name is still shown, as `field:
// value`, so a field added to a write later reaches the card without anyone remembering to.

import type { ChatProposalKind, ChatProposalSummary } from '@forge/contracts/chat-proposals';

type Args = Record<string, unknown>;

/** Fields that are where the write goes, never what it writes: the card's room already names them. */
const ADDRESSING: ReadonlySet<string> = new Set(['projectId', 'preview']);

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** A value as the card writes it: a string as typed, anything else as JSON. */
const valueText = (v: unknown): string =>
  v === null ? 'none' : typeof v === 'string' ? oneLine(v) : JSON.stringify(v);

const isEmpty = (v: unknown): boolean =>
  v === undefined || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && v.length === 0);

/** Every field of `args` the lines above did not show, as `field: value`. */
function restLines(args: Args, shown: readonly string[]): string[] {
  return Object.entries(args)
    .filter(([key, v]) => !shown.includes(key) && !ADDRESSING.has(key) && !isEmpty(v))
    .map(([key, v]) => `${key}: ${valueText(v)}`);
}

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
      if (verb === 'project') return 'project_change';
      break;
    }
  }
  throw new Error(
    `chat agreement: ${name} ${argsJson.slice(0, 120)} is a write the agreement gate holds, and no kind of record names it; add it to kindOfToolCall`,
  );
}

const FEEDBACK_TARGETS = ['requirement', 'issue', 'release', 'workflow', 'endpoint', 'screen'];

/** Feedback's one target, as its link reads. */
function feedbackTarget(args: Args): string[] {
  for (const field of FEEDBACK_TARGETS) {
    const v = str(args[field]);
    if (v) return [field === 'requirement' || field === 'issue' ? v : `${field} ${v}`];
  }
  return [];
}

function feedbackSummary(args: Args): ChatProposalSummary {
  const lines = [str(args.body), str(args.whereSeen) && `Where seen: ${str(args.whereSeen)}`]
    .filter((l): l is string => !!l)
    .map(oneLine);
  return {
    title: `Feedback (${str(args.kind) ?? 'unknown kind'}): ${str(args.title) ?? 'untitled'}`,
    lines: [
      ...lines,
      ...restLines(args, ['kind', 'title', 'body', 'whereSeen', ...FEEDBACK_TARGETS]),
    ],
    relates: feedbackTarget(args),
  };
}

function criteriaLines(args: Args): string[] {
  const criteria = Array.isArray(args.criteria) ? args.criteria : [];
  const bodies = criteria.map((c) => str((c as Args | null)?.body)).filter((b) => b !== null);
  const from = args.criteriaFrom as Args | undefined;
  const fromLine = str(from?.file)
    ? [
        `Criteria from ${str(from?.file)}${str(from?.section) ? `, section "${str(from?.section)}"` : ''}`,
      ]
    : [];
  return [...fromLine, ...bodies.map((b, i) => `${i + 1}. ${oneLine(b)}`)];
}

const designsOf = (args: Args): string[] =>
  Array.isArray(args.designs) ? args.designs.filter((d): d is string => typeof d === 'string') : [];

function requirementSummary(kind: ChatProposalKind, args: Args, ref: string | null) {
  const reason = str(args.reason);
  const title =
    kind === 'requirement_draft'
      ? `New requirement: ${str(args.title) ?? 'untitled'}`
      : `Revision of ${ref ?? 'a requirement'}`;
  return {
    title,
    lines: [
      ...(reason ? [`Why: ${oneLine(reason)}`] : []),
      ...criteriaLines(args),
      ...restLines(args, ['title', 'reason', 'criteria', 'criteriaFrom', 'designs', 'requirement']),
    ],
    relates: [...(ref ? [ref] : []), ...designsOf(args).map((d) => `design ${d}`)],
  };
}

const KEY_RE = /\b(?:[A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g;

function noteSummary(args: Args, textKey: string, title: string | null): ChatProposalSummary {
  const text = str(args[textKey]);
  return {
    title: `Remember: ${title ?? oneLine(text ?? '').slice(0, 80)}`,
    lines: [...(text ? [oneLine(text)] : []), ...restLines(args, [textKey, 'title'])],
    relates: [...new Set(text?.match(KEY_RE) ?? [])],
  };
}

/** A CLI argv's flags as the card reads them: each flag with the words that follow it. */
function flagLines(argv: readonly string[]): string[] {
  const lines: string[] = [];
  for (const word of argv) {
    if (word.startsWith('--') || lines.length === 0) lines.push(word);
    else lines[lines.length - 1] = `${lines[lines.length - 1]} ${word}`;
  }
  return lines;
}

function cliSummary(kind: ChatProposalKind, args: Args): ChatProposalSummary {
  const argv = argvOf(args);
  const body = str(args.body);
  const bodyLines = body ? [oneLine(body)] : [];
  if (kind === 'comment') {
    const target = argv[1] ?? 'an issue';
    return { title: `Comment on ${target}`, lines: bodyLines, relates: [target] };
  }
  if (kind === 'attachment') {
    const rest = argv.slice(1);
    const target = rest[0] === 'issue' ? (rest[1] ?? 'an issue') : (rest[0] ?? 'an issue');
    const files = rest.slice(rest[0] === 'issue' ? 2 : 1).map((p) => p.split('/').pop() ?? p);
    return { title: `Attach to ${target}`, lines: files, relates: [target] };
  }
  if (kind === 'project_change') {
    if (argv[1] === 'new') {
      return {
        title: 'Create a project',
        lines: [...flagLines(argv.slice(2)), ...bodyLines],
        relates: [],
      };
    }
    const slug = argv[1] ?? 'the project';
    return {
      title: `Change project ${slug}`,
      lines: [...flagLines(argv.slice(2)), ...bodyLines],
      relates: [],
    };
  }
  const target = argv[1] ?? 'an issue';
  return {
    title: `Change ${target}`,
    lines: [...flagLines(argv.slice(2)), ...bodyLines],
    relates: [target],
  };
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
      return noteSummary(args, 'text', str(args.title));
    case 'preferences':
      return {
        title: 'Your reply preferences',
        lines: [
          ...(str(args.answerStyle) ? [`Reply style: ${str(args.answerStyle)}`] : []),
          ...(args.assistantInstructions === null ? ['Clear your standing instructions'] : []),
          ...(str(args.assistantInstructions)
            ? [`Standing instructions: ${oneLine(str(args.assistantInstructions) ?? '')}`]
            : []),
          ...restLines(args, ['answerStyle', 'assistantInstructions']),
        ],
        relates: [],
      };
    case 'report_save':
      return {
        title: `Save the report ${str(args.templateId) ?? ''}`.trim(),
        lines: restLines(args, ['templateId']),
        relates: [],
      };
    default:
      if (name !== 'forge') throw new Error(`chat agreement: ${name} is not a ${kind} tool`);
      return cliSummary(kind, args);
  }
}

/** The record a REST path names: `/api/issues/<ref>`, or a project's requirement, feedback or workflow. */
function pathTarget(path: string): string | null {
  const bare = path.split('?')[0] ?? path;
  const issue = /^\/api\/issues\/([^/]+)(?:\/|$)/.exec(bare);
  if (issue?.[1]) return decodeURIComponent(issue[1]);
  const item =
    /^\/api\/projects\/[^/]+\/(requirements|feedback|workflows|issues)\/([^/]+)(?:\/|$)/.exec(bare);
  if (!item?.[2]) return null;
  const ref = decodeURIComponent(item[2]);
  return item[1] === 'workflows' ? `design ${ref}` : ref;
}

/** A requirement's link the path names: what is linked (issue, design, contract) and which. */
function linkOf(path: string): { what: string; which: string | null } {
  const bare = path.split('?')[0] ?? path;
  const m = /\/requirements\/[^/]+\/(issues|workflows|contracts)(?:\/(.+))?$/.exec(bare);
  const what = m?.[1] === 'workflows' ? 'design' : m?.[1] === 'contracts' ? 'contract' : 'issue';
  return { what, which: m?.[2] ? decodeURIComponent(m[2]) : null };
}

function linkSummary(method: string, path: string, body: Args): ChatProposalSummary {
  const req = pathTarget(path) ?? 'a requirement';
  const { what, which } = linkOf(path);
  const named = which ?? str(body.workflowId) ?? str(body.issue) ?? str(body.contract);
  const thing = `${what}${named ? ` ${named}` : ''}`;
  const removing = method === 'DELETE';
  return {
    title: removing ? `Unlink ${thing} from ${req}` : `Link ${req} to ${thing}`,
    lines: restLines(body, ['workflowId', 'issue', 'contract']),
    relates: [req, ...(named ? [`${what} ${named}`] : [])],
  };
}

function issueChangeSummary(method: string, path: string, body: Args): ChatProposalSummary {
  const target = pathTarget(path) ?? 'an issue';
  const edge = /\/dependencies(?:\/([^/?]+))?/.exec(path);
  if (edge) {
    return {
      title:
        method === 'DELETE'
          ? `Remove a link of ${target}${edge[1] ? ` (edge ${decodeURIComponent(edge[1])})` : ''}`
          : `Change the links of ${target}`,
      lines: restLines(body, []),
      relates: [target, ...(str(body.dependsOnId) ? [str(body.dependsOnId) as string] : [])],
    };
  }
  return {
    title: method === 'DELETE' ? `Delete ${target}` : `Change ${target}`,
    lines: restLines(body, []),
    relates: [target],
  };
}

function projectChangeSummary(path: string, body: Args): ChatProposalSummary {
  const act = /\/(archive|unarchive)(?:\?|$)/.exec(path)?.[1];
  const title =
    act === 'archive'
      ? 'Archive the project'
      : act === 'unarchive'
        ? 'Unarchive the project'
        : 'Change the project';
  return { title, lines: restLines(body, []), relates: [] };
}

/** An Agent session's held REST request, as the hold read it. */
export interface HeldRestRequest {
  kind: ChatProposalKind;
  method: string;
  path: string;
  /** Its JSON body, parsed; empty for a body that is not JSON. */
  body: Args;
  /** The file a multipart attachment carries, read by the hold that parsed it. */
  attachmentName: string | null;
}

/** What an Agent session's held REST request would record. */
export function summaryOfRest(request: HeldRestRequest): ChatProposalSummary {
  const { kind, method, path, body, attachmentName } = request;
  const target = pathTarget(path);
  switch (kind) {
    case 'feedback':
      return feedbackSummary(body);
    case 'requirement_draft':
      return requirementSummary(kind, body, null);
    case 'requirement_revision':
      return requirementSummary(kind, body, target);
    case 'memory_note':
      return noteSummary(body, 'textContent', str((body.metadata as Args | undefined)?.title));
    case 'comment':
      return {
        title: `Comment on ${target ?? 'a record'}`,
        lines: [
          ...(str(body.body) ? [oneLine(str(body.body) ?? '')] : []),
          ...restLines(body, ['body']),
        ],
        relates: target ? [target] : [],
      };
    case 'attachment':
      return {
        title: `Attach to ${target ?? 'a record'}`,
        lines: [attachmentName ?? str(body.name) ?? 'a file'],
        relates: target ? [target] : [],
      };
    case 'requirement_link':
      return linkSummary(method, path, body);
    case 'issue_change':
      return issueChangeSummary(method, path, body);
    case 'project_change':
      return projectChangeSummary(path, body);
    case 'report_save':
      return { title: 'Save a report', lines: restLines(body, []), relates: [] };
    case 'preferences':
      return { title: 'Your reply preferences', lines: restLines(body, []), relates: [] };
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
    case 'requirement_link':
      return nested('requirement') ?? str(answered.key);
    default:
      return str(answered.key) ?? str(answered.id);
  }
}
