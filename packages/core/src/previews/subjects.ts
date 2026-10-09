// A preview no issue's run holds (REQ-41; docs/proposals/chat-first.md "Idea preview", "Reproduce"):
// an idea is built by a sketch run on a throwaway branch its box cuts, about one requirement or
// feedback item (BC-14), and edited from chat (BC-15); a reproduce serves a past build of a feedback
// item, checked out with no run at all (BC-17), on demo data where the project names it (BC-22).
// Core names the box, the paths and the branch; the box cuts the checkout and decides nothing.

import { randomBytes, randomUUID } from 'node:crypto';
import {
  type OpenPreviewRequest,
  PREVIEW_LIMITS,
  type PreviewCheckout,
  type PreviewRecord,
  type PreviewSubject,
  SKETCH_BRANCH,
} from '@forge/contracts/preview';
import { eq, sql } from 'drizzle-orm';
import {
  createChatSessionRow,
  dispatchInteractiveTurn,
  mergeSessionMetadata,
  readBoxAuthority,
  refusalError,
  requestSessionSend,
} from '../agent-sessions/index.js';
import { db } from '../db/client.js';
import { agentSessions } from '../db/schema.js';
import { type PreviewRow, previews } from '../db/schema-previews.js';
import {
  findAvailableDeviceForProject,
  resolveSessionRepoPathForDevice,
} from '../lib/device-pool.js';
import { logger } from '../lib/logger.js';
import { accessFor, type PreviewActor, planOf, pushStart, refuse, siteOrRefuse } from './access.js';
import { newPreviewLabel } from './domain.js';
import { previewView } from './read.js';
import type { PreviewPlan } from './rules.js';
import {
  feedbackForBuild,
  type Item,
  itemOf,
  releaseLiveAt,
  releaseNamed,
  releaseOfRun,
  releaseOfSha,
} from './subject-reads.js';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const suffix = (n: number) => [...randomBytes(n)].map((b) => BASE32[b % 32]).join('');

/** Where a box cuts a checkout core names: inside the binding's checkout, as a run's worktree is. */
const checkoutPath = (repoPath: string, name: string) =>
  `${repoPath.replace(/\/+$/, '')}/.claude/worktrees/${name}`;

interface Placed {
  deviceId: string;
  repoPath: string;
}

/**
 * What a box declares when it runs a chat session confined, its network included
 * (`agent-sessions/chat-device.ts:CONFINED_CHAT_CAPABILITY`): a sketch run is a chat session, so it
 * holds only its own turn token and reaches no host but the model and this core, which is what
 * keeps it from pushing anywhere. A reproduce runs no session, so any bound box serves one.
 */
const CONFINES_A_CHAT = 'confinedChatNetwork';

/** The box that builds or serves it: one bound to the project and online, with `capability` if named. */
async function placeOn(projectId: string, capability?: string): Promise<Placed> {
  const deviceId = await findAvailableDeviceForProject(
    projectId,
    capability ? { requireCapability: capability } : {},
  );
  if (!deviceId) {
    throw refuse(
      'PREVIEW_RUNNER_UNSUPPORTED',
      capability
        ? 'no box bound to this project is online with a forge-runner that runs a sketch confined: start or update one (forge-runner update)'
        : 'no box bound to this project is online to serve the preview: start one',
    );
  }
  const repoPath = await resolveSessionRepoPathForDevice(projectId, deviceId);
  if (!repoPath) {
    throw refuse(
      'PREVIEW_RUNNER_UNSUPPORTED',
      `box ${deviceId}'s binding to this project names no checkout, so it cannot cut one for a preview: set it with \`forge-runner bind <slug> --path <dir>\``,
    );
  }
  return { deviceId, repoPath };
}

async function insertSubjectPreview(args: {
  projectId: string;
  deviceId: string;
  subject: Exclude<PreviewSubject, { kind: 'issue' }>;
  checkout: PreviewCheckout;
  sessionId: string | null;
  feedbackId: string | null;
  plan: PreviewPlan;
  createdBy: string;
}): Promise<PreviewRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(previews)
      .values({
        projectId: args.projectId,
        subjectKind: args.subject.kind,
        subject: args.subject,
        checkout: args.checkout,
        sessionId: args.sessionId,
        feedbackId: args.feedbackId,
        deviceId: args.deviceId,
        slug: newPreviewLabel((n) => randomBytes(n)),
        command: args.plan.settings?.command ?? '',
        port: args.plan.settings?.port ?? null,
        idleMinutes: args.plan.settings?.idleMinutes ?? PREVIEW_LIMITS.idleMinutes.default,
        createdBy: args.createdBy,
      })
      .returning();
    if (!row) throw new Error('previews: the insert returned no row');
    await pushStart(tx, row, args.plan);
    return row;
  });
}

/** Open an idea or a reproduce preview (`POST /api/projects/:id/previews`). */
export async function openSubjectPreview(
  projectId: string,
  request: OpenPreviewRequest,
  actor: PreviewActor,
): Promise<PreviewRecord> {
  const site = siteOrRefuse();
  const row =
    request.kind === 'idea'
      ? await openIdea(projectId, request, actor)
      : await openReproduce(projectId, request, actor);
  return previewView(row, site);
}

// ---- idea (BC-14, BC-15)

async function itemOrRefuse(projectId: string, key: string): Promise<Item> {
  const item = await itemOf(projectId, key);
  if (!item) {
    throw refuse(
      'PREVIEW_ITEM_UNKNOWN',
      `${key} is not a requirement or feedback item of this project`,
    );
  }
  return item;
}

async function openIdea(
  projectId: string,
  request: Extract<OpenPreviewRequest, { kind: 'idea' }>,
  actor: PreviewActor,
): Promise<PreviewRow> {
  await accessFor(projectId, actor, 'project.write', 'open an idea preview');
  const item = await itemOrRefuse(projectId, request.about);
  const kept = request.from === undefined ? null : await keptOf(projectId, request.from);
  const plan = await planOf(projectId, 'idea');
  const placed = await placeOn(projectId, CONFINES_A_CHAT);
  const branch = `sketch/${item.kind === 'requirement' ? 'req' : 'fb'}-${item.key.split('-')[1]}-${suffix(6)}`;
  if (!SKETCH_BRANCH.test(branch))
    throw new Error(`previews: sketch branch ${branch} is malformed`);
  const path = checkoutPath(placed.repoPath, branch.replace('/', '-'));
  const session = await createChatSessionRow({
    projectId,
    userId: actor.userId,
    deviceId: placed.deviceId,
    repoPath: path,
    title: `Sketch of ${item.key}: ${request.brief.slice(0, 60)}`,
    metadata: {
      deviceId: placed.deviceId,
      sketch: {
        about: item.key,
        branch,
        brief: request.brief,
        asked: [...(kept?.asked ?? []), request.brief],
      },
    },
  });
  return insertSubjectPreview({
    projectId,
    deviceId: placed.deviceId,
    subject: { kind: 'idea', about: { kind: item.kind, key: item.key } as never, branch },
    // from a kept preview, the sketch is cut at the head the keep committed: the edit continues it
    checkout: { kind: 'sketch', repoPath: placed.repoPath, path, branch, base: kept?.head ?? null },
    sessionId: session.id,
    feedbackId: null,
    plan,
    createdBy: actor.userId,
  });
}

/**
 * The kept preview `from` names: a `preview` picture of this project whose content holds that
 * preview's id. A box that never held its branch (another box, a pruned repository) fails the start
 * REF_NOT_FOUND-style at the checkout, by name; nothing here guesses another base.
 */
async function keptOf(
  projectId: string,
  from: string,
): Promise<{ head: string; asked: string[] } | null> {
  const rows = (await db.execute(sql`
    SELECT p.content FROM requirement_pictures p
      JOIN requirements r ON r.id = p.requirement_id
     WHERE r.project_id = ${projectId}::uuid AND p.kind = 'preview' AND p.content->>'previewId' = ${from}
     ORDER BY p.written_at DESC LIMIT 1
  `)) as unknown as { content: { head: string; asked: string[] } }[];
  const content = rows[0]?.content;
  if (!content) {
    throw refuse(
      'PREVIEW_NOT_FOUND',
      `no kept idea preview ${from} in this project: "from" names a preview that was kept as a requirement's picture`,
    );
  }
  return { head: content.head, asked: content.asked };
}

/** What a sketch run is told: the item, the ask, and that its branch goes nowhere. */
export function sketchBrief(args: {
  about: string;
  title: string;
  brief: string;
  branch: string;
  url: string;
}): string {
  return [
    `You are a sketch run for ${args.about} (${args.title}). A person asked, in chat, to see this idea live:`,
    '',
    args.brief,
    '',
    `Build it in this working directory, on branch ${args.branch}. A dev server already serves it at ${args.url} and shows each edit by hot reload, so make the change in the source and do not build, deploy or restart anything.`,
    'This is a sketch to look at, not delivery: never push, never merge, never open a pull request, and never file or change any Forge record (no issue, comment, requirement or feedback). Commits stay on this local branch, if you make any.',
    'When the change shows, say in two or three sentences what you changed and what the person should look at.',
  ].join('\n');
}

const turnsOf = async (sessionId: string) =>
  (
    (await db.execute(
      sql`SELECT count(*)::int AS n FROM agent_session_turns WHERE agent_session_id = ${sessionId}::uuid`,
    )) as unknown as { n: number }[]
  )[0]?.n ?? 0;

async function sessionOf(sessionId: string) {
  const [session] = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  return session ?? null;
}

async function projectSlug(projectId: string): Promise<string> {
  const rows = (await db.execute(
    sql`SELECT slug FROM projects WHERE id = ${projectId}::uuid`,
  )) as unknown as { slug: string }[];
  const slug = rows[0]?.slug;
  if (!slug) throw new Error(`previews: project ${projectId} has no slug`);
  return slug;
}

/** What the sketch was built from, oldest first: the brief, then each change asked in the preview. */
export async function askedOf(row: PreviewRow): Promise<string[]> {
  const session = row.sessionId === null ? null : await sessionOf(row.sessionId);
  const asked = (session?.metadata as { sketch?: { asked?: string[] } } | null)?.sketch?.asked;
  return asked ?? [];
}

/** A person's message as a turn of the sketch session, under a token minted for them. */
async function turnFor(row: PreviewRow, userId: string, message: string): Promise<void> {
  const session = row.sessionId === null ? null : await sessionOf(row.sessionId);
  if (!session) throw refuse('PREVIEW_NO_RUN', `preview ${row.id}'s sketch run is gone`);
  const client = { deviceId: row.deviceId, migrated: false };
  const read = await readBoxAuthority({
    deviceId: row.deviceId,
    projectId: row.projectId,
    asker: { userId, viaTokenId: null },
  });
  if (!read.ok) throw refusalError(read.refusal);
  const authority = read.authority;
  await dispatchInteractiveTurn({
    session,
    project: { id: row.projectId, slug: await projectSlug(row.projectId) },
    client,
    authority,
    message,
    broadcastEvent: 'agent-session.updated',
  });
}

/**
 * The sketch run is briefed once its dev server serves the checkout it edits (BC-14): before that
 * there is no worktree to edit. A run already briefed is not briefed again when the preview reopens.
 */
export async function briefSketchOnLive(row: PreviewRow, url: string): Promise<void> {
  if (row.subjectKind !== 'idea' || row.subject?.kind !== 'idea' || row.sessionId === null) return;
  if ((await turnsOf(row.sessionId)) > 0) return;
  const session = await sessionOf(row.sessionId);
  const sketch = (session?.metadata as { sketch?: { brief?: string } } | null)?.sketch;
  const item = await itemOf(row.projectId, row.subject.about.key);
  const message = sketchBrief({
    about: row.subject.about.key,
    title: item?.title ?? row.subject.about.key,
    brief: sketch?.brief ?? '',
    branch: row.subject.branch,
    url,
  });
  try {
    await turnFor(row, row.createdBy, message);
  } catch (err) {
    logger.error({ err, previewId: row.id }, 'previews: the sketch run could not be briefed');
  }
}

/**
 * A person's change for an idea (BC-15): a sketch run working its last turn takes it as an inject;
 * an idle one takes it as its next turn. Either way the edit reaches the preview by hot reload.
 */
export async function sendIdeaMessage(
  row: PreviewRow,
  actor: PreviewActor,
  text: string,
  url: string,
): Promise<{ sent: true; seq: number }> {
  const session = row.sessionId === null ? null : await sessionOf(row.sessionId);
  if (!session) throw refuse('PREVIEW_NO_RUN', `preview ${row.id}'s sketch run is gone`);
  // what the sketch is built from is kept on its session, so a keep can say it
  const sketch = (session.metadata as { sketch?: { asked?: string[] } } | null)?.sketch ?? {};
  await mergeSessionMetadata(session.id, {
    sketch: { ...sketch, asked: [...(sketch.asked ?? []), text] },
  });
  const body = `A person viewing this idea's live preview (${url}) asks for a change:\n\n${text}\n\nMake it in this working directory; the preview shows it by hot reload. Never push, merge or file anything.`;
  if (session.status === 'running' || session.status === 'queued') {
    const sent = await requestSessionSend({
      agentSessionId: session.id,
      kind: 'inject',
      intentId: randomUUID(),
      body,
      actor: { userId: actor.userId, reason: 'preview message', source: 'rest' },
    });
    if (!sent.published) {
      throw refuse(
        'PREVIEW_NO_RUN',
        `the sketch run of preview ${row.id} has no box to reach: nothing was sent`,
      );
    }
    return { sent: true, seq: sent.row.seq };
  }
  await turnFor(row, actor.userId, body);
  return { sent: true, seq: 0 };
}

// ---- reproduce (BC-17, BC-22)

/**
 * The build a reproduce serves: the release or sha named, else the release the item names, else the
 * release live when the item was filed (every release run ships to production, and Forge keeps no
 * other environment's history). None of these: PREVIEW_BUILD_UNKNOWN, naming what to give.
 */
async function buildOf(
  projectId: string,
  request: Extract<OpenPreviewRequest, { kind: 'reproduce' }>,
  item: { createdAt: Date; releaseRunId: string | null },
): Promise<{ sha: string; release: string | null }> {
  const named = request.build;
  if (named && 'release' in named) {
    const build = await releaseNamed(projectId, named.release);
    if (!build) {
      throw refuse(
        'PREVIEW_BUILD_UNKNOWN',
        `no shipped release ${named.release} in this project: name a release it shipped, or a sha`,
        '/build/release',
      );
    }
    return build;
  }
  if (named && 'sha' in named) {
    const sha = named.sha.toLowerCase();
    return { sha, release: await releaseOfSha(projectId, sha) };
  }
  const targeted = item.releaseRunId ? await releaseOfRun(projectId, item.releaseRunId) : null;
  if (targeted) return targeted;
  const live = await releaseLiveAt(projectId, item.createdAt);
  if (live) return live;
  throw refuse(
    'PREVIEW_BUILD_UNKNOWN',
    `${request.feedback} names no release and none had shipped when it was filed (${item.createdAt.toISOString()}), so Forge cannot tell which build its reporter used: name a release or a sha`,
    '/build',
  );
}

async function openReproduce(
  projectId: string,
  request: Extract<OpenPreviewRequest, { kind: 'reproduce' }>,
  actor: PreviewActor,
): Promise<PreviewRow> {
  await accessFor(projectId, actor, 'project.read', 'open a reproduce preview');
  const item = await feedbackForBuild(projectId, request.feedback);
  if (!item) {
    throw refuse(
      'PREVIEW_ITEM_UNKNOWN',
      `${request.feedback} is not a feedback item of this project`,
    );
  }
  const build = await buildOf(projectId, request, item);
  const plan = await planOf(projectId, 'reproduce');
  const placed = await placeOn(projectId);
  const path = checkoutPath(
    placed.repoPath,
    `reproduce-${request.feedback.toLowerCase()}-${suffix(6)}`,
  );
  return insertSubjectPreview({
    projectId,
    deviceId: placed.deviceId,
    subject: { kind: 'reproduce', feedback: request.feedback, build, record: request.record },
    checkout: { kind: 'reproduce', repoPath: placed.repoPath, path, sha: build.sha },
    sessionId: null,
    feedbackId: item.id,
    plan,
    createdBy: actor.userId,
  });
}
