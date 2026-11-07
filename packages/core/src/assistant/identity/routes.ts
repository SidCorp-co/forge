/**
 * ISS-977 — the two steps a person walks to link their chat account to their Forge user.
 *
 * propose and confirm are project-scoped because the project supplies the chat
 * credential the speaker's address is read through; the map they write is keyed
 * on the channel instance and resolves for every project reading it.
 *
 * ISS-976 — a project admin names the Forge account a chat account is, where no
 * address matches it; the naming holds only in that project, and is undone there.
 */

import type { SpeakerRefusalCode } from '@forge/contracts/assistant';
import { Hono } from 'hono';
import { z } from 'zod';
import type { ConversationAdapter } from '../../db/schema-conversations.js';
import { type RefusalError, refuser } from '../../lib/refusal.js';
import { type AuthVars, assertEmailVerified, requireAuth } from '../../middleware/auth.js';
import { invalid, zValidator } from '../../middleware/zod-validator.js';
import { requiresOnParam } from '../../permissions/index.js';
import { confirmSpeakerLink } from '../service.js';
import { proposeCandidates, type SpeakerCandidate } from './candidates.js';
import { lookupSpeakerProfile, type SpeakerProfile } from './directory.js';
import { nameSpeaker, namingsOf, type SpeakerNaming, undoNaming } from './named-links.js';
import {
  isConversationAdapter,
  type SpeakerRefusal,
  sourceUnknownRefusal,
  tellSpeakerLinked,
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

const speakerBody = zValidator(
  'json',
  speakerBodySchema,
  invalid(`invalid body: ${SPEAKER_BODY_REQUIRED.message}`),
);

const refuseSpeaker = refuser<SpeakerRefusalCode>('SPEAKER_SOURCE_UNKNOWN');

/** A speaker refusal in the one envelope, nothing written. */
const refused = (refusal: SpeakerRefusal, path = ''): RefusalError =>
  refuseSpeaker(refusal.code, refusal.message, path);

// project access is refused before the body is read, so a stranger learns nothing from a 400
const projectParam = zValidator(
  'param',
  z.object({ projectId: z.uuid() }),
  invalid('invalid path: /api/projects/<project uuid>/speaker-links'),
);
const projectAccess = requiresOnParam('project.write');

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
      message: `${source} reports no email address for speaker id ${externalId}, and an address is the only thing this page matches a candidate on. The way that needs none: a project admin names the Forge account this chat account is, with POST /api/projects/${projectId}/speaker-links/named { source, externalId, userId, reason }. Otherwise an address set on the chat account lets this page match it.`,
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
  projectParam,
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
  projectParam,
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
          ? 'that speaker is already linked to you.'
          : 'that speaker is already linked to another Forge user.',
      );
    }
    await tellSpeakerLinked({
      source: profile.source,
      namespace: profile.namespace,
      externalId: profile.externalId,
      label: profile.username,
      userId,
    });
    return c.json({ link: confirmed.link }, 201);
  },
);

const projectAdmin = requiresOnParam('project.admin');

const namingBody = zValidator(
  'json',
  z.object({
    source: z.string(),
    externalId: z.string(),
    /** The Forge account the chat account is, by its id: never matched from a name or an address. */
    userId: z.uuid(),
    /** Why the admin names it, kept with the naming. */
    reason: z.string().trim().min(1).max(500),
  }),
  invalid(
    'invalid body: { source, externalId, userId, reason }. "externalId" is the chat server\'s own user id for the speaker, "userId" the Forge account\'s id, and "reason" why you name it.',
  ),
);

const undoBody = zValidator(
  'json',
  z.object({ reason: z.string().trim().min(1).max(500) }),
  invalid('invalid body: { reason }, why the naming is undone.'),
);

const namingParam = zValidator(
  'param',
  z.object({ projectId: z.uuid(), namingId: z.uuid() }),
  invalid('invalid path: /api/projects/<project uuid>/speaker-links/named/<naming uuid>'),
);

function namingView(n: SpeakerNaming) {
  return {
    id: n.id,
    source: n.source,
    namespace: n.externalNamespace,
    externalId: n.externalId,
    label: n.externalLabel,
    userId: n.userId,
    namedBy: n.namedBy,
    reason: n.reason,
    namedAt: n.namedAt,
    undoneBy: n.undoneBy,
    undoneAt: n.undoneAt,
    undoReason: n.undoReason,
  };
}

speakerLinkProjectRoutes.get(
  '/projects/:projectId/speaker-links/named',
  projectParam,
  projectAdmin,
  async (c) => {
    const namings = await namingsOf(c.req.valid('param').projectId);
    return c.json({ namings: namings.map(namingView) });
  },
);

speakerLinkProjectRoutes.post(
  '/projects/:projectId/speaker-links/named',
  projectParam,
  projectAdmin,
  namingBody,
  async (c) => {
    const projectId = c.req.valid('param').projectId;
    const raw = c.req.valid('json');
    const body = readBody(raw);
    if (isRefusal(body)) throw refused(body, '/source');
    // the chat server says the id is an account it holds; its address is not read
    const lookup = await lookupSpeakerProfile({ projectId, ...body });
    if (!lookup.found) throw refused(lookup.refusal, '/externalId');
    const named = await nameSpeaker({
      projectId,
      profile: lookup.profile,
      userId: raw.userId,
      namedBy: c.get('userId'),
      reason: raw.reason,
    });
    if (!named.ok) {
      throw refused(
        named.refusal,
        named.refusal.code === 'SPEAKER_NAMED_NOT_A_MEMBER' ? '/userId' : '/externalId',
      );
    }
    await tellSpeakerLinked({
      source: lookup.profile.source,
      namespace: lookup.profile.namespace,
      externalId: lookup.profile.externalId,
      label: lookup.profile.username,
      userId: raw.userId,
      projectId,
    });
    return c.json({ naming: namingView(named.naming) }, 201);
  },
);

speakerLinkProjectRoutes.delete(
  '/projects/:projectId/speaker-links/named/:namingId',
  namingParam,
  projectAdmin,
  undoBody,
  async (c) => {
    const { projectId, namingId } = c.req.valid('param');
    const undone = await undoNaming({
      projectId,
      namingId,
      by: c.get('userId'),
      reason: c.req.valid('json').reason,
    });
    if (!undone.ok) throw refused(undone.refusal, '/namingId');
    return c.json({ naming: namingView(undone.naming) });
  },
);
