/**
 * ISS-977 — the four steps a person walks to link their chat account to their
 * Forge user, and to take the link back.
 *
 * propose and confirm are project-scoped because the project supplies the chat
 * credential the speaker's address is read through; the map they write is keyed
 * on the channel instance and resolves for every project reading it. list and
 * unlink are the person's own and name no project.
 */

import type { SpeakerRefusalCode } from '@forge/contracts/assistant';
import { Hono, type MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import type { ConversationAdapter } from '../../db/schema-conversations.js';
import { type RefusalError, refuser } from '../../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { zValidator } from '../../middleware/zod-validator.js';
import { actorFor, projectResource, requireCan } from '../../permissions/index.js';
import { listSpeakerLinks } from '../read.js';
import { confirmSpeakerLink, unlinkSpeaker } from '../service.js';
import { proposeCandidates, type SpeakerCandidate } from './candidates.js';
import { lookupSpeakerProfile, type SpeakerProfile } from './directory.js';
import {
  isConversationAdapter,
  type SpeakerRefusal,
  sourceUnknownRefusal,
} from './speaker-link.js';

const speakerBodySchema = z.object({
  source: z.string().optional(),
  externalId: z.string().optional(),
});

type SpeakerBody = z.infer<typeof speakerBodySchema>;

const SPEAKER_BODY_REQUIRED: SpeakerRefusal = {
  code: 'SPEAKER_SOURCE_UNKNOWN',
  message:
    'both "source" and "externalId" are required. "source" is the chat channel, "externalId" is that channel\'s own user id for the speaker — never their display name.',
};

const speakerBody = zValidator('json', speakerBodySchema, (result) => {
  if (!result.success) {
    throw new HTTPException(400, {
      message: `invalid body: ${SPEAKER_BODY_REQUIRED.message}`,
      cause: { code: 'BAD_REQUEST' },
    });
  }
});

const refuseSpeaker = refuser<SpeakerRefusalCode>('SPEAKER_SOURCE_UNKNOWN');

/** A speaker refusal in the one envelope, nothing written. */
const refused = (refusal: SpeakerRefusal, path = ''): RefusalError =>
  refuseSpeaker(refusal.code, refusal.message, path);

// cm:why project access is refused before the body is read, so a stranger learns nothing from a 400
const projectAccess: MiddlewareHandler<{ Variables: AuthVars }> = async (c, next) => {
  await requireCan(
    actorFor(c.get('userId')),
    'project.write',
    projectResource(c.req.param('projectId') ?? ''),
  );
  await next();
};

function readBody(
  raw: SpeakerBody,
): { source: ConversationAdapter; externalId: string } | SpeakerRefusal {
  const source = raw.source?.trim() ?? '';
  const externalId = raw.externalId?.trim() ?? '';
  if (!source || !externalId) return SPEAKER_BODY_REQUIRED;
  if (!isConversationAdapter(source)) return sourceUnknownRefusal(source);
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
  source: ConversationAdapter,
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

speakerLinkProjectRoutes.post(
  '/projects/:projectId/speaker-links/proposals',
  projectAccess,
  speakerBody,
  async (c) => {
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    const body = readBody(c.req.valid('json'));
    if (isRefusal(body)) throw refused(body, '/source');
    const found = await profileAndCandidates(projectId, body.source, body.externalId);
    if (isRefusal(found)) throw refused(found, '/externalId');
    return c.json(describe(found.profile, found.candidates, userId));
  },
);

speakerLinkProjectRoutes.post(
  '/projects/:projectId/speaker-links',
  projectAccess,
  speakerBody,
  async (c) => {
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    const body = readBody(c.req.valid('json'));
    if (isRefusal(body)) throw refused(body, '/source');
    const found = await profileAndCandidates(projectId, body.source, body.externalId);
    if (isRefusal(found)) throw refused(found, '/externalId');
    const { profile, candidates } = found;

    const mine = candidates.filter((cand) => cand.userId === userId);
    if (!mine.some((cand) => cand.confirmable)) {
      const near = mine.find((cand) => cand.matchedOn === 'local-part');
      if (near) {
        throw refuseSpeaker(
          'SPEAKER_ADDRESS_DIFFERS',
          `${profile.source} reports ${profile.email} for that speaker, and your Forge address is ${near.email}. The local parts match but the domains do not, which proposes a link and cannot confirm one. Make the two addresses the same, on either side, and confirm again.`,
        );
      }
      throw refuseSpeaker(
        'SPEAKER_NOT_THE_TARGET',
        `${profile.source} reports ${profile.email} for that speaker, which is not your Forge address. A link is confirmed by the person being mapped, signed in themselves — never by an administrator on their behalf, because the authority checked afterwards is the mapped user's and not the confirmer's.`,
      );
    }

    const confirmed = await confirmSpeakerLink(profile, userId);
    if (!confirmed.ok) {
      throw refuseSpeaker(
        'SPEAKER_ALREADY_LINKED',
        confirmed.heldBy === userId
          ? 'that speaker is already linked to you. Unlink it first if you mean to re-make the link.'
          : 'that speaker is already linked to another Forge user. Whoever holds the link unlinks it before it can be re-made.',
      );
    }
    return c.json({ link: confirmed.link }, 201);
  },
);

export const speakerLinkMeRoutes = new Hono<{ Variables: AuthVars }>();
speakerLinkMeRoutes.use('/me/speaker-links', requireAuth(), assertEmailVerified());
speakerLinkMeRoutes.use('/me/speaker-links/*', requireAuth(), assertEmailVerified());

speakerLinkMeRoutes.get('/me/speaker-links', async (c) => {
  const links = await listSpeakerLinks(c.get('userId'));
  return c.json({ links });
});

speakerLinkMeRoutes.delete('/me/speaker-links/:source/:namespace/:externalId', async (c) => {
  const source = c.req.param('source');
  if (!isConversationAdapter(source)) {
    throw refused(sourceUnknownRefusal(source), '/source');
  }
  const unlinked = await unlinkSpeaker(
    c.get('userId'),
    source,
    c.req.param('namespace'),
    c.req.param('externalId'),
  );
  if (unlinked === 0) {
    throw new HTTPException(404, {
      message: 'you hold no link for that speaker, so there is nothing to unlink.',
      cause: { code: 'SPEAKER_UNLINKED' },
    });
  }
  return c.json({ unlinked });
});
