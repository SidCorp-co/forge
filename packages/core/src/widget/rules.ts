// The widget's guards, pure: where a request may come from, who a visitor is under the binding's
// identity mode, the caps a binding sets, and what a status link says of a phase.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FeedbackPhase, FeedbackRoute } from '@forge/contracts/feedback';
import {
  WIDGET_LIMIT_DEFAULTS,
  WIDGET_SIGNATURE_MAX_AGE_S,
  type WidgetBindingConfig,
  type WidgetIdentityMode,
  type WidgetSessionRequest,
  type WidgetStatus,
} from '@forge/contracts/widget';
import type { RefusalError } from '../lib/refusal.js';
import { refuse } from './refuse.js';

export type WidgetLimits = { -readonly [K in keyof typeof WIDGET_LIMIT_DEFAULTS]: number };

/** The binding's caps, each one it leaves out at the contract's default. */
export function limitsOf(config: Pick<WidgetBindingConfig, 'limits'>): WidgetLimits {
  const set = config.limits ?? {};
  return {
    messageMaxChars: set.messageMaxChars ?? WIDGET_LIMIT_DEFAULTS.messageMaxChars,
    turnsPerConversation: set.turnsPerConversation ?? WIDGET_LIMIT_DEFAULTS.turnsPerConversation,
    turnsPerVisitorPerDay: set.turnsPerVisitorPerDay ?? WIDGET_LIMIT_DEFAULTS.turnsPerVisitorPerDay,
    sessionsPerAddressPerHour:
      set.sessionsPerAddressPerHour ?? WIDGET_LIMIT_DEFAULTS.sessionsPerAddressPerHour,
  };
}

/**
 * Whether a site-key request may come from where it says. The frame the loader opens is served on
 * Forge's own web origin, so that is the Origin its calls carry; the binding's own origins may call
 * the config and session routes from their pages too. A request with no Origin is refused where it
 * changes something (`required`): a browser always sends one on a POST.
 *
 * This is not what keeps other sites from embedding the widget — any page can open Forge's frame.
 * That boundary is the frame page's `Content-Security-Policy: frame-ancestors`, set from the
 * binding's allowed origins (`web-host/host.ts:webHost`), which the browser enforces.
 */
export function originRefusal(
  origin: string | undefined,
  allowed: { site: readonly string[]; frame: readonly string[] },
  required: boolean,
): RefusalError | null {
  if (origin === undefined || origin === '') {
    return required
      ? refuse(
          'WIDGET_ORIGIN_REFUSED',
          'this request names no Origin; the widget is opened from a page of one of the origins its site allows',
        )
      : null;
  }
  const said = origin.toLowerCase();
  if (allowed.site.includes(said) || allowed.frame.includes(said)) return null;
  return refuse(
    'WIDGET_ORIGIN_REFUSED',
    `origin ${origin} is not one this site allows to embed its widget; its allowed origins are set on its binding in the project's integrations`,
  );
}

/**
 * The page that framed the widget, as the frame read it, refused where it is not one of the
 * binding's allowed origins. A claim the frame reports, a second line behind `frame-ancestors`.
 */
export function embeddedRefusal(
  embeddedAt: string | undefined,
  allowed: readonly string[],
): RefusalError | null {
  if (embeddedAt === undefined || allowed.includes(embeddedAt.toLowerCase())) return null;
  return refuse(
    'WIDGET_ORIGIN_REFUSED',
    `the widget was framed by ${embeddedAt}, which is not one of the origins this site allows; its allowed origins are set on its binding in the project's integrations`,
    '/embeddedAt',
  );
}

/** Who a visitor is, as the binding's identity mode takes them. */
export interface VisitorIdentity {
  mode: WidgetIdentityMode;
  email: string | null;
  name: string | null;
  signedUserId: string | null;
}

/** The visitor a session opens for, or the refusal that names what the binding's mode needs. */
export function identityOf(
  mode: WidgetIdentityMode,
  request: WidgetSessionRequest,
  signingSecret: string | null,
  nowMs: number,
): VisitorIdentity {
  if (mode !== 'signed') {
    if (request.signed) {
      throw refuse(
        'WIDGET_REFUSED',
        `this site identifies visitors as ${mode}, so it reads no signed identity; send visitor instead`,
        '/signed',
      );
    }
    const email = request.visitor?.email ?? null;
    if (mode === 'email' && email === null) {
      throw refuse(
        'WIDGET_IDENTITY_REQUIRED',
        'this site asks every visitor for an email before the chat opens; send visitor.email',
        '/visitor/email',
      );
    }
    return { mode, email, name: request.visitor?.name ?? null, signedUserId: null };
  }
  if (request.visitor) {
    throw refuse(
      'WIDGET_REFUSED',
      "this site's own backend vouches for its visitors, so an email or a name travels inside signed, never beside it",
      '/visitor',
    );
  }
  const signed = request.signed;
  if (!signed) {
    throw refuse(
      'WIDGET_IDENTITY_REQUIRED',
      "this site opens the chat only for a visitor its own backend signed; send signed { userId, ts, sig } from the site's identify call",
      '/signed',
    );
  }
  const bad = signatureRefusal(signingSecret, signed, nowMs);
  if (bad) throw bad;
  return {
    mode,
    email: signed.email ?? null,
    name: signed.name ?? null,
    signedUserId: signed.userId,
  };
}

/** `sig` is the hex HMAC-SHA256 of `${userId}.${ts}` under the binding's secret, `ts` within the max age. */
export function signatureRefusal(
  secret: string | null,
  signed: { userId: string; ts: number; sig: string },
  nowMs: number,
): RefusalError | null {
  if (!secret) {
    return refuse(
      'WIDGET_SIGNATURE_INVALID',
      'this site holds no signing secret to check a signature against; rotate its integration secret, and sign with the one that answers',
      '/signed/sig',
    );
  }
  const skew = Math.abs(Math.floor(nowMs / 1000) - signed.ts);
  if (skew > WIDGET_SIGNATURE_MAX_AGE_S) {
    return refuse(
      'WIDGET_SIGNATURE_INVALID',
      `the signature was made at ${signed.ts}, ${skew} s from now; a signature is good for ${WIDGET_SIGNATURE_MAX_AGE_S} s, so sign again`,
      '/signed/ts',
    );
  }
  const expected = createHmac('sha256', secret).update(`${signed.userId}.${signed.ts}`).digest();
  const given = Buffer.from(signed.sig, 'hex');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return refuse(
      'WIDGET_SIGNATURE_INVALID',
      "the signature does not match this site's signing secret: sig is the hex HMAC-SHA256 of the userId, a dot and the ts",
      '/signed/sig',
    );
  }
  return null;
}

type Said = Pick<WidgetStatus, 'phase' | 'says'>;

const SAYS = {
  received: 'We received your report and will look at it soon.',
  again: 'We are looking at your report again.',
  accepted: 'Your report was accepted and is waiting to be worked on.',
  planned: 'Your report was accepted as a change we plan to make.',
  started: 'Work on your report has started.',
  shipped: 'A fix for your report has been released.',
  declined: 'We decided not to act on this report.',
  duplicate: 'This was already reported, and we follow it there.',
  answered: 'Your question was answered by the team.',
  deleted: 'The details of this report were deleted.',
} as const;

/**
 * What a visitor's status link says of where their item stands: one of five phases and one plain
 * sentence, never the issue, the requirement or the person carrying it.
 */
export function visitorStatusOf(item: {
  phase: FeedbackPhase;
  route: FeedbackRoute | null;
  redacted: boolean;
}): Said {
  if (item.redacted) return { phase: 'closed', says: SAYS.deleted };
  if (item.route === 'duplicate') return { phase: 'closed', says: SAYS.duplicate };
  if (item.route === 'answer') return { phase: 'closed', says: SAYS.answered };
  switch (item.phase) {
    case 'new':
      return { phase: 'received', says: SAYS.received };
    case 'reopened':
      return { phase: 'triaged', says: SAYS.again };
    case 'triaged':
      return {
        phase: 'triaged',
        says: item.route === 'issue' || item.route === null ? SAYS.accepted : SAYS.planned,
      };
    case 'planned':
      return { phase: 'in_progress', says: SAYS.started };
    case 'resolved':
    case 'verified':
      return { phase: 'shipped', says: SAYS.shipped };
    case 'declined':
      return { phase: 'closed', says: SAYS.declined };
  }
}
