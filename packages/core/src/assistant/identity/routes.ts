/**
 * ISS-977 — the four steps a person walks to link their chat account to their
 * Forge user, and to take the link back.
 *
 * propose and confirm are project-scoped because the project supplies the chat
 * credential the speaker's address is read through; the map they write is keyed
 * on the channel instance and resolves for every project reading it. list and
 * unlink are the person's own and name no project.
 */

import { and, desc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { db } from '../../db/client.js';
import type { ChatSessionSource } from '../../db/schema.js';
import { assistantSpeakerLinks } from '../../db/schema-speaker-links.js';
import { assertProjectAccess } from '../../lib/authz.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { proposeCandidates, type SpeakerCandidate } from './candidates.js';
import { lookupSpeakerProfile, type SpeakerProfile } from './directory.js';
import { isChatSessionSource, type SpeakerRefusal, sourceUnknownRefusal } from './speaker-link.js';

interface SpeakerBody {
  source?: unknown;
  externalId?: unknown;
}

function readBody(
  raw: SpeakerBody,
): { source: ChatSessionSource; externalId: string } | SpeakerRefusal {
  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  const externalId = typeof raw.externalId === 'string' ? raw.externalId.trim() : '';
  if (!source || !externalId) {
    return {
      code: 'SPEAKER_SOURCE_UNKNOWN',
      message:
        'both "source" and "externalId" are required. "source" is the chat channel, "externalId" is that channel\'s own user id for the speaker — never their display name.',
    };
  }
  if (!isChatSessionSource(source)) return sourceUnknownRefusal(source);
  return { source, externalId };
}

function isRefusal(value: unknown): value is SpeakerRefusal {
  return typeof value === 'object' && value !== null && 'code' in value && 'message' in value;
}

function describe(profile: SpeakerProfile, candidates: SpeakerCandidate[], userId: string) {
  return {
    speaker: {
      source: profile.source,
      namespace: profile.namespace,
      externalId: profile.externalId,
      username: profile.username,
      emailOnChannel: profile.email,
    },
    candidates,
    // cm:guard the caller is told whether THEY may confirm, and never handed a selected candidate. A single candidate is a proposal like any other: selecting it because it is alone is guessing the intent behind input that named no user.
    youMayConfirm: candidates.some((c) => c.userId === userId && c.confirmable),
    confirm: {
      method: 'POST',
      body: { source: profile.source, externalId: profile.externalId },
      as: 'the person being mapped, signed in themselves',
    },
  };
}

async function profileAndCandidates(
  projectId: string,
  source: ChatSessionSource,
  externalId: string,
): Promise<{ profile: SpeakerProfile; candidates: SpeakerCandidate[] } | SpeakerRefusal> {
  const lookup = await lookupSpeakerProfile({ projectId, source, externalId });
  if (!lookup.found) return lookup.refusal;
  if (!lookup.profile.email) {
    return {
      code: 'SPEAKER_EMAIL_ABSENT',
      message: `${source} reports no email address for speaker id ${externalId}, and an address is the only thing a candidate is matched on. Set one on the chat account, or link through a channel that reports one.`,
    };
  }
  return { profile: lookup.profile, candidates: await proposeCandidates(lookup.profile.email) };
}

export const speakerLinkProjectRoutes = new Hono<{ Variables: AuthVars }>();
speakerLinkProjectRoutes.use(
  '/projects/:projectId/speaker-links/*',
  requireAuth(),
  assertEmailVerified(),
);
speakerLinkProjectRoutes.use(
  '/projects/:projectId/speaker-links',
  requireAuth(),
  assertEmailVerified(),
);

// cm:guard project access is asserted BEFORE the directory is read, on both routes — the read spends this project's Rocket.Chat bot credential, so a caller who is not a member must be refused while the credential is still untouched rather than after it has answered for them
speakerLinkProjectRoutes.post('/projects/:projectId/speaker-links/proposals', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectAccess(projectId, userId);
  const body = readBody(await c.req.json<SpeakerBody>().catch(() => ({})));
  if (isRefusal(body)) return c.json({ error: body.message, code: body.code }, 400);
  const found = await profileAndCandidates(projectId, body.source, body.externalId);
  if (isRefusal(found)) return c.json({ error: found.message, code: found.code }, 404);
  return c.json(describe(found.profile, found.candidates, userId));
});

speakerLinkProjectRoutes.post('/projects/:projectId/speaker-links', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.param('projectId');
  await assertProjectAccess(projectId, userId);
  const body = readBody(await c.req.json<SpeakerBody>().catch(() => ({})));
  if (isRefusal(body)) return c.json({ error: body.message, code: body.code }, 400);
  const found = await profileAndCandidates(projectId, body.source, body.externalId);
  if (isRefusal(found)) return c.json({ error: found.message, code: found.code }, 404);
  const { profile, candidates } = found;

  const mine = candidates.filter((cand) => cand.userId === userId);
  // cm:guard a local-part candidate PROPOSES and never confirms — it is offered so a person can see the near-miss, and accepting it would let anyone bind a chat account whose local part equals their own on some other domain. The residual on the whole-address tier is ISS-977's own priced trade-off: an operator who can edit a chat account's email can generate this prompt, and the exit condition named there is a redeemed pairing code (ISS-200) or a per-speaker rate limit.
  if (!mine.some((cand) => cand.confirmable)) {
    const near = mine.find((cand) => cand.matchedOn === 'local-part');
    if (near) {
      return c.json(
        {
          code: 'SPEAKER_ADDRESS_DIFFERS',
          error: `${profile.source} reports ${profile.email} for that speaker, and your Forge address is ${near.email}. The local parts match but the domains do not, which proposes a link and cannot confirm one. Make the two addresses the same, on either side, and confirm again.`,
        },
        403,
      );
    }
    return c.json(
      {
        code: 'SPEAKER_NOT_THE_TARGET',
        error: `${profile.source} reports ${profile.email} for that speaker, which is not your Forge address. A link is confirmed by the person being mapped, signed in themselves — never by an administrator on their behalf, because the authority checked afterwards is the mapped user's and not the confirmer's.`,
      },
      403,
    );
  }

  // cm:guard let the unique index decide, never a SELECT before the INSERT — two confirmations of one speaker both read no row, and the loser of a select-then-insert reaches the constraint as a 500 instead of the 409 this route documents
  const [row] = await db
    .insert(assistantSpeakerLinks)
    .values({
      source: profile.source,
      externalNamespace: profile.namespace,
      externalId: profile.externalId,
      externalLabel: profile.username,
      userId,
      confirmedVia: 'channel_email_match',
    })
    .onConflictDoNothing()
    .returning();
  if (!row) {
    const [held] = await db
      .select({ userId: assistantSpeakerLinks.userId })
      .from(assistantSpeakerLinks)
      .where(
        and(
          eq(assistantSpeakerLinks.source, profile.source),
          eq(assistantSpeakerLinks.externalNamespace, profile.namespace),
          eq(assistantSpeakerLinks.externalId, profile.externalId),
        ),
      )
      .limit(1);
    return c.json(
      {
        code: 'SPEAKER_ALREADY_LINKED',
        error:
          held?.userId === userId
            ? 'that speaker is already linked to you. Unlink it first if you mean to re-make the link.'
            : 'that speaker is already linked to another Forge user. Whoever holds the link unlinks it before it can be re-made.',
      },
      409,
    );
  }
  return c.json({ link: row }, 201);
});

export const speakerLinkMeRoutes = new Hono<{ Variables: AuthVars }>();
speakerLinkMeRoutes.use('/me/speaker-links', requireAuth(), assertEmailVerified());
speakerLinkMeRoutes.use('/me/speaker-links/*', requireAuth(), assertEmailVerified());

speakerLinkMeRoutes.get('/me/speaker-links', async (c) => {
  const links = await db
    .select()
    .from(assistantSpeakerLinks)
    .where(eq(assistantSpeakerLinks.userId, c.get('userId')))
    .orderBy(desc(assistantSpeakerLinks.confirmedAt));
  return c.json({ links });
});

// cm:guard DELETE removes the row — there is no disabled state, because a row present IS the authorization. Scoped to the caller's own userId in the same WHERE as the key, so no id in the path can reach somebody else's link.
speakerLinkMeRoutes.delete('/me/speaker-links/:source/:namespace/:externalId', async (c) => {
  const source = c.req.param('source');
  if (!isChatSessionSource(source)) {
    const refusal = sourceUnknownRefusal(source);
    return c.json({ error: refusal.message, code: refusal.code }, 400);
  }
  const deleted = await db
    .delete(assistantSpeakerLinks)
    .where(
      and(
        eq(assistantSpeakerLinks.userId, c.get('userId')),
        eq(assistantSpeakerLinks.source, source),
        eq(assistantSpeakerLinks.externalNamespace, c.req.param('namespace')),
        eq(assistantSpeakerLinks.externalId, c.req.param('externalId')),
      ),
    )
    .returning({ id: assistantSpeakerLinks.id });
  if (deleted.length === 0) {
    return c.json(
      {
        code: 'SPEAKER_UNLINKED',
        error: 'you hold no link for that speaker, so there is nothing to unlink.',
      },
      404,
    );
  }
  return c.json({ unlinked: deleted.length });
});
