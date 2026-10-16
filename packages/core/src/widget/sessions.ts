/**
 * A visitor's session on a widget binding: opening one under the binding's identity mode and its
 * caps, reading it back from its token, and taking a message on it. Every cap a binding sets is
 * held here, before a model turn is spent: the message length, the turns of one conversation, the
 * turns of one visitor in a day, and the sessions one address opens in an hour.
 */

import { randomUUID } from 'node:crypto';
import type {
  WidgetHistory,
  WidgetMessageAccepted,
  WidgetPageContext,
  WidgetPublicConfig,
  WidgetRefusalCode,
  WidgetSession,
  WidgetSessionRequest,
} from '@forge/contracts/widget';
import { WIDGET_SITE_KEY_PATTERN } from '@forge/contracts/widget';
import {
  collectInboundMessage,
  openConversationIn,
  readMessages,
  readMessagesInRange,
} from '../conversations/index.js';
import { db } from '../db/client.js';
import { activeWidgetBinding, type WidgetBinding } from '../integrations/widget/index.js';
import { allowedOrigins } from '../middleware/cors.js';
import { consumeRateLimit } from '../middleware/rate-limit.js';
import { publishWidgetEvent, widgetMessageOf } from './events.js';
import { widgetConversationPorts, widgetVenueId, widgetVenueOf } from './ports.js';
import { refuse } from './refuse.js';
import {
  embeddedRefusal,
  identityOf,
  limitsOf,
  originRefusal,
  type WidgetLimits,
} from './rules.js';
import {
  draftsOfSession,
  draftView,
  insertSession,
  knownVisitor,
  liveSessionByHash,
  type SessionRow,
  setPageContext,
  spendTurn,
  visitorOfSignedUser,
} from './store.js';
import { mintSessionToken, sessionTokenHash } from './tokens.js';
import { answerSession, DEFAULT_WIDGET_TITLE } from './turn.js';

/** How long a session's token is good for; a frame opens a new one after. */
const SESSION_TTL_MS = 12 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

/** Forge's own web origins, where the frame the loader opens is served. */
const frameOrigins = () => allowedOrigins().map((o) => o.replace(/\/+$/, '').toLowerCase());

/** The live binding a site key names, refused by name where none does. */
export async function siteOf(siteKey: string): Promise<WidgetBinding> {
  const binding = await activeWidgetBinding({ siteKey });
  if (!binding) {
    throw refuse(
      'WIDGET_SITE_UNKNOWN',
      'no live widget answers this site key; check the key on the page against the binding in the project',
      '/siteKey',
    );
  }
  return binding;
}

/**
 * The origins that may frame the widget this site key names — its binding's allowed origins — or
 * null for a key no live binding holds. The web host sets them as the frame page's
 * `frame-ancestors`, the boundary the browser enforces.
 */
export async function widgetFrameAncestors(siteKey: string): Promise<readonly string[] | null> {
  if (!WIDGET_SITE_KEY_PATTERN.test(siteKey)) return null;
  return (await activeWidgetBinding({ siteKey }))?.config.allowedOrigins ?? null;
}

/** Refuse a request from an origin the binding does not allow; `required` refuses a missing one. */
export function assertOrigin(
  binding: WidgetBinding,
  origin: string | undefined,
  required: boolean,
): void {
  const refused = originRefusal(
    origin,
    { site: binding.config.allowedOrigins, frame: frameOrigins() },
    required,
  );
  if (refused) throw refused;
}

export function publicConfigOf(binding: WidgetBinding): WidgetPublicConfig {
  return {
    title: binding.config.title ?? DEFAULT_WIDGET_TITLE,
    greeting: binding.config.greeting ?? null,
    accent: binding.config.accent ?? null,
    identity: { mode: binding.config.identity.mode },
    messageMaxChars: limitsOf(binding.config).messageMaxChars,
  };
}

/** A cap met: the refusal, and the same words on the stream where a session is listening. */
function capMet(
  conversationId: string | null,
  code: WidgetRefusalCode,
  detail: string,
  path = '',
): Error {
  if (conversationId) publishWidgetEvent(conversationId, { type: 'limit', code, detail });
  return refuse(code, detail, path);
}

async function visitorIdFor(
  binding: WidgetBinding,
  request: WidgetSessionRequest,
  signedUserId: string | null,
): Promise<string> {
  // a signed client user is one visitor however many sessions they open; any other visitor
  // continues as the id their frame kept, where this binding issued it
  if (signedUserId) {
    return (await visitorOfSignedUser(binding.bindingId, signedUserId)) ?? randomUUID();
  }
  if (request.visitorId && (await knownVisitor(binding.bindingId, request.visitorId))) {
    return request.visitorId;
  }
  return randomUUID();
}

export async function openSession(input: {
  siteKey: string;
  origin: string | undefined;
  address: string | undefined;
  request: WidgetSessionRequest;
}): Promise<WidgetSession> {
  const binding = await siteOf(input.siteKey);
  assertOrigin(binding, input.origin, true);
  const framed = embeddedRefusal(input.request.embeddedAt, binding.config.allowedOrigins);
  if (framed) throw framed;
  const now = Date.now();
  const identity = identityOf(
    binding.config.identity.mode,
    input.request,
    binding.signingSecret,
    now,
  );
  const limits = limitsOf(binding.config);
  const opened = await consumeRateLimit(
    `widget-session:${binding.bindingId}:${input.address ?? 'unknown'}`,
    limits.sessionsPerAddressPerHour,
    HOUR_MS,
  );
  if (!opened.allowed) {
    throw capMet(
      null,
      'WIDGET_LIMIT_REACHED',
      `this address opened ${limits.sessionsPerAddressPerHour} chats on this site in the last hour; try again later`,
    );
  }
  const visitorId = await visitorIdFor(binding, input.request, identity.signedUserId);
  const token = mintSessionToken();
  const sessionId = randomUUID();
  const expiresAt = new Date(now + SESSION_TTL_MS);
  const session = await db.transaction(async (tx) => {
    const conversation = await openConversationIn(
      tx,
      widgetVenueOf({ id: sessionId, projectId: binding.projectId }),
    );
    return insertSession(tx, {
      id: sessionId,
      tokenHash: token.hash,
      bindingId: binding.bindingId,
      projectId: binding.projectId,
      conversationId: conversation.id,
      visitorId,
      identityMode: identity.mode,
      visitorEmail: identity.email,
      visitorName: identity.name,
      signedUserId: identity.signedUserId,
      pageContext: input.request.context ?? null,
      embeddedAt: input.request.embeddedAt?.toLowerCase() ?? null,
      createdAt: new Date(now),
      expiresAt,
    });
  });
  return {
    sessionToken: token.token,
    visitorId: session.visitorId,
    conversationId: session.conversationId,
    expiresAt: session.expiresAt.toISOString(),
  };
}

/** The session a bearer token names, with its live binding; refused by name where it names none. */
export async function sessionOf(
  authorization: string | undefined,
): Promise<{ session: SessionRow; binding: WidgetBinding }> {
  const token = /^Bearer\s+(\S+)$/i.exec(authorization ?? '')?.[1];
  const hash = token ? sessionTokenHash(token) : null;
  if (!hash) {
    throw refuse(
      'WIDGET_SESSION_INVALID',
      'this request carries no widget session token; send Authorization: Bearer <session token> from the session the chat opened',
    );
  }
  const session = await liveSessionByHash(hash, new Date());
  if (!session) {
    throw refuse(
      'WIDGET_SESSION_INVALID',
      'this session token is unknown or has expired; open a new chat session',
    );
  }
  const binding = await activeWidgetBinding({ bindingId: session.bindingId });
  if (!binding) {
    throw refuse(
      'WIDGET_SESSION_INVALID',
      "this session's site no longer takes chats; its widget was switched off",
    );
  }
  return { session, binding };
}

/** Hold a message to every cap the binding sets, before it is taken in. */
async function holdToCaps(session: SessionRow, limits: WidgetLimits, text: string): Promise<void> {
  if (text.length > limits.messageMaxChars) {
    throw capMet(
      session.conversationId,
      'WIDGET_LIMIT_REACHED',
      `this message is ${text.length} characters, and this site takes at most ${limits.messageMaxChars}; shorten it`,
      '/text',
    );
  }
  if (session.turns >= limits.turnsPerConversation) {
    throw capMet(
      session.conversationId,
      'WIDGET_LIMIT_REACHED',
      `this chat reached its ${limits.turnsPerConversation} messages; open a new chat to go on`,
    );
  }
  const day = await consumeRateLimit(
    `widget-visitor-day:${session.bindingId}:${session.visitorId}`,
    limits.turnsPerVisitorPerDay,
    DAY_MS,
  );
  if (!day.allowed) {
    throw capMet(
      session.conversationId,
      'WIDGET_LIMIT_REACHED',
      `you sent ${limits.turnsPerVisitorPerDay} messages on this site today; try again tomorrow`,
    );
  }
}

export async function sendVisitorMessage(
  session: SessionRow,
  binding: WidgetBinding,
  input: { text: string; context?: WidgetPageContext | undefined },
): Promise<WidgetMessageAccepted> {
  const limits = limitsOf(binding.config);
  await holdToCaps(session, limits, input.text);
  const collected = await collectInboundMessage({
    ports: widgetConversationPorts,
    frame: { session },
    message: input.text,
    speakerKey: session.visitorId,
    speakerLabel: session.visitorName ?? 'Visitor',
    withinCollection: async (tx) => {
      // the turn is spent with the message, so two sends at the cap's edge cannot both be taken in
      if (!(await spendTurn(tx, session.id, limits.turnsPerConversation))) {
        throw capMet(
          session.conversationId,
          'WIDGET_LIMIT_REACHED',
          `this chat reached its ${limits.turnsPerConversation} messages; open a new chat to go on`,
        );
      }
      if (input.context) await setPageContext(tx, session.id, input.context);
    },
  });
  if (collected.kind !== 'collected') {
    throw new Error(`widget: session ${session.id}'s conversation could not be placed as a venue`);
  }
  const [row] = await readMessagesInRange(session.conversationId, {
    firstSeq: collected.seq,
    lastSeq: collected.seq,
    limit: 1,
  });
  if (!row)
    throw new Error(`widget: message ${collected.messageId} was taken in and not read back`);
  const message = widgetMessageOf(row);
  publishWidgetEvent(session.conversationId, { type: 'message', message });
  await answerSession(session.id, `widget-send:${session.id}`);
  return { message };
}

/** The conversation as the frame shows it, oldest first, and every draft the session was offered. */
export async function historyOf(
  session: SessionRow,
  binding: WidgetBinding,
): Promise<WidgetHistory> {
  // every visitor turn the chat may take, each with its reply, and room for the fallbacks between
  const rows = await readMessages(
    session.conversationId,
    2 * limitsOf(binding.config).turnsPerConversation + 20,
  );
  return {
    messages: rows
      .filter(
        (r) =>
          (r.role === 'user' || r.role === 'assistant') &&
          r.silenceReason === null &&
          r.content.trim() !== '',
      )
      .map(widgetMessageOf),
    drafts: (await draftsOfSession(session.id)).map(draftView),
  };
}

export { widgetVenueId };
