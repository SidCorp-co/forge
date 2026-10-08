// The write an agreement earns (workflow chat-turn step write): exactly the call that was held, made
// as the person who agreed, under a token minted for that one proposal (`chat agreement <id>`) and
// revoked once it answered. An Assistant tool call runs through the project toolset built for that
// person; an Agent session's REST request is replayed through core's own app. Either way the door
// the call meets checks the person's access as it stands now, so an agreement never widens it.

import type { ChatProposalRecord } from '@forge/contracts/chat-proposals';
import { eq } from 'drizzle-orm';
import { getConversation, readRoomDocumentByName } from '../../conversations/index.js';
import { agreementTokenNameFor } from '../../credentials/pat-format.js';
import {
  AGENT_TURN_MENU,
  CHAT_TURN_MENU,
  mintTurnCredential,
  type TurnAuthority,
  type TurnCredential,
} from '../../credentials/turn-credential.js';
import { db } from '../../db/client.js';
import { projects } from '../../db/schema.js';
import { toolResultText } from '../tools/mcp-adapter.js';
import { buildChatToolContext } from '../tools/principal.js';
import { buildProjectToolset } from '../tools/registry.js';
import { withTurnImages } from '../tools/turn-images.js';
import type { ChatProposalRow, HeldRestCall, HeldToolCall } from './store.js';
import { recordRefOf } from './summary.js';

/** The agreement token outlives a slow CLI call and nothing more; it is revoked when the write answers. */
const AGREEMENT_TOKEN_TTL_MS = 2 * 60 * 1000;
const FAILURE_MAX = 1_000;

type Replay = (request: Request) => Promise<Response>;
let replay: Replay | null = null;

/** Core's own app, which an Agent session's held request is replayed through; provided at boot. */
export function provideAgreementReplay(fetch: Replay): void {
  replay = fetch;
}

export type WriteOutcome =
  | { ok: true; record: ChatProposalRecord; answered: string }
  | { ok: false; failure: string };

function parsedObject(text: string): Record<string, unknown> {
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function hrefOf(slug: string, ref: string | null): string | null {
  if (!ref) return null;
  if (/^FB-\d+$/.test(ref)) return `/projects/${slug}/feedback/${ref}`;
  const req = /^(REQ-\d+)/.exec(ref);
  return req ? `/projects/${slug}/requirements/${req[1]}` : null;
}

const clipped = (text: string) =>
  text.length > FAILURE_MAX ? `${text.slice(0, FAILURE_MAX - 1)}…` : text;

async function slugOf(projectId: string): Promise<string> {
  const [row] = await db
    .select({ slug: projects.slug })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!row) throw new Error(`chat agreement: project ${projectId} is gone`);
  return row.slug;
}

async function writeToolCall(
  row: ChatProposalRow,
  credential: TurnCredential,
  slug: string,
  personId: string,
): Promise<{ ok: boolean; text: string }> {
  const call = row.call as HeldToolCall;
  const room = await getConversation(row.conversationId);
  const images = call.images ?? [];
  const ctx = buildChatToolContext({
    credential,
    projectSlug: slug,
    turn: {
      conversationId: row.conversationId,
      speakerUserId: personId,
      handleUserId: row.handleUserId,
      ecosystemId: room?.ecosystemId ?? null,
      ...(images.length > 0 ? { images } : {}),
      readDocument: (file) => readRoomDocumentByName(row.conversationId, file),
    },
  });
  const project = buildProjectToolset(ctx);
  const tools = images.length > 0 ? withTurnImages(project, images) : project;
  const result = await tools.execute(call.name, call.arguments);
  return { ok: result.isError !== true, text: toolResultText(result) };
}

async function writeRestCall(
  row: ChatProposalRow,
  credential: TurnCredential,
): Promise<{ ok: boolean; text: string }> {
  if (!replay) {
    throw new Error(
      "chat agreement: core's app was not provided, so a held REST request cannot be written; the process entry calls provideAgreementReplay before it serves",
    );
  }
  const call = row.call as HeldRestCall;
  const response = await replay(
    new Request(`http://forge.internal${call.path}`, {
      method: call.method,
      headers: {
        ...call.headers,
        authorization: `Bearer ${credential.token}`,
        ...(call.contentType ? { 'content-type': call.contentType } : {}),
      },
      ...(row.body ? { body: new Uint8Array(row.body) } : {}),
    }),
  );
  return { ok: response.ok, text: await response.text() };
}

/** Make the held call as `authority`'s person; the outcome the proposal is settled with. */
export async function writeAgreed(
  row: ChatProposalRow,
  authority: TurnAuthority,
): Promise<WriteOutcome> {
  const credential = await mintTurnCredential({
    authority,
    menu: row.form === 'tool' ? CHAT_TURN_MENU : AGENT_TURN_MENU,
    name: agreementTokenNameFor(row.id),
    ttlMs: AGREEMENT_TOKEN_TTL_MS,
  });
  try {
    const slug = await slugOf(row.projectId);
    const written =
      row.form === 'tool'
        ? await writeToolCall(row, credential, slug, authority.userId)
        : await writeRestCall(row, credential);
    if (!written.ok) return { ok: false, failure: clipped(written.text) };
    const ref = recordRefOf(row.kind, parsedObject(written.text));
    return { ok: true, record: { ref, href: hrefOf(slug, ref) }, answered: written.text };
  } finally {
    await credential.revoke();
  }
}
