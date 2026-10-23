// A card that failed twice is not offered a third time (REQ-41 BC-28). Dev, 2026-10-21 (conversation
// a760cd5f): the chat offered a Feedback item four times; the owner pressed Record it on each and each
// failed, three of them FEEDBACK_TARGET_NOT_ONE. The same act on the same target, refused twice in one
// conversation, is a defect in Forge, not in the person's words: the third offer is refused by name,
// the defect is filed into Forge's own feedback (the door `forge_feedback` files through, joined to an
// open item by its signal key), and the model is told to say so.

import type { ChatProposalKind } from '@forge/contracts/chat-proposals';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { feedback } from '../../db/schema-feedback.js';
import type { CallToolResult } from '../../lib/tool-result.js';
import { toolError } from '../tools/mcp-adapter.js';
import { type ChatProposalRow, failedProposalsOf } from './store.js';

/** Failed presses of one act on one target a conversation takes before the next offer is refused. */
export const FAILED_PRESSES_ALLOWED = 2;

const KEY = /^[A-Z][A-Z0-9]*-\d+$/i;

function argsOf(argsJson: string): Record<string, unknown> {
  try {
    const v = JSON.parse(argsJson) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The kinds that make a new record or change the project: every call of one kind is one target. */
const NEW_RECORD: ReadonlySet<ChatProposalKind> = new Set([
  'feedback',
  'requirement_draft',
  'memory_note',
  'preferences',
  'report_save',
  'project_change',
]);

/**
 * What a held call acts on: the project, for a kind that makes a new record (a Feedback item names
 * the requirement it is about, and is still a new item of this project); else the record it names,
 * an issue or a requirement.
 */
export function targetOf(kind: ChatProposalKind, argsJson: string): string {
  if (NEW_RECORD.has(kind)) return 'project';
  const args = argsOf(argsJson);
  const argv = Array.isArray(args.argv) ? args.argv : [];
  const named = [args.requirement, args.issue, args.issueKey, args.key, argv[1]].find(
    (v): v is string => typeof v === 'string' && KEY.test(v.trim()),
  );
  return named ? named.trim().toUpperCase() : 'project';
}

/** The refusal code a failed press named, and its sentence, as the proposal kept them. */
export function failureOf(failure: string | null): { code: string; detail: string } {
  const text = failure ?? '';
  try {
    const p = JSON.parse(text) as {
      type?: unknown;
      detail?: unknown;
      stderr?: unknown;
      error?: unknown;
    };
    const code =
      typeof p.type === 'string' ? (/refusal:([A-Z0-9_]+)$/.exec(p.type)?.[1] ?? null) : null;
    const detail = [p.detail, p.stderr, p.error].find((v): v is string => typeof v === 'string');
    return { code: code ?? 'UNNAMED', detail: (detail ?? text).slice(0, 300) };
  } catch {
    return { code: 'UNNAMED', detail: text.slice(0, 300) };
  }
}

/** The presses of `kind` on `target` that failed in this conversation, oldest first. */
export async function failedPresses(
  conversationId: string,
  kind: ChatProposalKind,
  target: string,
): Promise<ChatProposalRow[]> {
  return (await failedProposalsOf(conversationId, kind)).filter((r) => {
    const call = r.call as { arguments?: unknown };
    return targetOf(kind, typeof call.arguments === 'string' ? call.arguments : '{}') === target;
  });
}

interface Offer {
  projectId: string;
  conversationId: string;
  personId: string;
  kind: ChatProposalKind;
  /** The words a person reads for the kind ("Feedback item"). */
  kindWords: string;
  target: string;
}

/** Files the defect into Forge's own feedback; the sentence the model is told, recorded or not. */
async function recordDefect(offer: Offer, failed: readonly ChatProposalRow[]): Promise<string> {
  const reasons = failed.map((r) => failureOf(r.failure));
  const about = offer.target === 'project' ? 'this project' : offer.target;
  // read when a defect is filed, so a gate that never meets one never loads the feedback module
  const { fileForgeFeedback } = await import('../../feedback/index.js');
  const filed = await fileForgeFeedback({
    actor: { userId: offer.personId, agency: 'agent' },
    request: {
      kind: 'bug',
      severity: 'high',
      title: `The chat's ${offer.kindWords} on ${about} failed each time it was pressed`.slice(
        0,
        300,
      ),
      body: [
        `In conversation ${offer.conversationId}, the person pressed Record it on the chat's ${offer.kindWords} on ${about} ${failed.length} times and each press failed:`,
        ...failed.map((r, i) => `- proposal ${r.id}: ${reasons[i]?.code}: ${reasons[i]?.detail}`),
        'A further offer was refused (REQ-41 BC-28): the card the chat builds for this act fails when pressed.',
      ].join('\n'),
      whereSeen: `Assistant chat, conversation ${offer.conversationId}`,
      signalKey: `chat:refused-twice:${offer.kind}:${reasons[0]?.code ?? 'UNNAMED'}`,
    },
    source: { projectId: offer.projectId, issueId: null, runId: null, clientVersion: null },
  });
  if (!filed.ok) {
    const why = filed.refusals.map((r) => `${r.code}: ${r.detail}`).join('; ');
    return `Forge could not record this defect in its own feedback (${why}); tell the person that too, in those words.`;
  }
  const [row] = await db
    .select({ seq: feedback.fbSeq })
    .from(feedback)
    .where(eq(feedback.id, filed.id))
    .limit(1);
  const key = row ? `FB-${row.seq}` : filed.id;
  return filed.created
    ? `Forge recorded the defect in its own feedback as ${key}; tell the person so, naming ${key}.`
    : `Forge added this to ${key}, already open in its own feedback for the same failure; tell the person so, naming ${key}.`;
}

/**
 * The refusal of an offer whose act already failed twice on its target in this conversation, with
 * the defect recorded; null where the offer may be made.
 */
export async function refusedTwice(offer: Offer): Promise<CallToolResult | null> {
  const failed = await failedPresses(offer.conversationId, offer.kind, offer.target);
  if (failed.length < FAILED_PRESSES_ALLOWED) return null;
  const told = await recordDefect(offer, failed);
  const reasons = failed.map((r) => {
    const f = failureOf(r.failure);
    return `${f.code} (${f.detail.slice(0, 160)})`;
  });
  return toolError(
    `CHAT_WRITE_REFUSED_TWICE: the person pressed Record it on this ${offer.kindWords} ${failed.length} times in this conversation and each press failed: ${reasons.join('; ')}. A third card would fail the same way, so none is offered and nothing was written. ${told} Say what failed in plain words, and do not offer this ${offer.kindWords} again in this conversation.`,
  );
}
