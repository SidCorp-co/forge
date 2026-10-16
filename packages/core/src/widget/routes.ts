// The feedback widget's public door, under `/api/widget`, behind no sign-in: the site key names a
// binding and its Origin is checked against it; a visitor session token, in `Authorization`,
// carries everything after the session opens; a status link's token carries itself. Every answer
// is sealed: never cached, never indexed, and never naming the page it came from.

import {
  WIDGET_IDENTITY_MODES,
  widgetMessageRequestSchema,
  widgetSessionRequestSchema,
} from '@forge/contracts/widget';
import { Hono } from 'hono';
import { z } from 'zod';
import { getClientIp } from '../middleware/rate-limit.js';
import { invalid, zValidator } from '../middleware/zod-validator.js';
import { confirmDraft, discardDraft } from './drafts.js';
import {
  assertOrigin,
  historyOf,
  openSession,
  publicConfigOf,
  sendVisitorMessage,
  sessionOf,
  siteOf,
} from './sessions.js';
import { statusOfLink } from './status.js';
import { widgetStream } from './stream.js';

const siteParam = z.strictObject({ siteKey: z.string().min(1).max(100) });
const draftParam = z.strictObject({ draftId: z.uuid() });
const statusParam = z.strictObject({ token: z.string().min(1).max(200) });

const SESSION_SHAPE = `invalid body: { visitor?: { email?, name? }, signed?: { userId, ts, sig, email?, name? }, context?: { url, title?, productId?, appVersion?, locale?, userAgent?, extra? }, embeddedAt?: the origin that framed the widget, visitorId? } — the site's identity mode (${WIDGET_IDENTITY_MODES.join(' | ')}) says which`;
const MESSAGE_SHAPE =
  'invalid body: { text: 1..8000 characters, context?: { url, title?, productId?, appVersion?, locale?, userAgent?, extra? } }';

export const widgetRoutes = new Hono();

// every answer, a refusal and the stream included, is sealed after it is made
widgetRoutes.use('*', async (c, next) => {
  await next();
  c.res.headers.set('Cache-Control', 'no-store');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set('X-Robots-Tag', 'noindex, nofollow');
});

widgetRoutes.get(
  '/status/:token',
  zValidator('param', statusParam, invalid('invalid path: /api/widget/status/<status token>')),
  async (c) => {
    return c.json(await statusOfLink(c.req.valid('param').token));
  },
);

widgetRoutes.get(
  '/:siteKey/config',
  zValidator('param', siteParam, invalid('invalid path: /api/widget/<site key>/config')),
  async (c) => {
    const binding = await siteOf(c.req.valid('param').siteKey);
    assertOrigin(binding, c.req.header('origin'), false);
    return c.json(publicConfigOf(binding));
  },
);

widgetRoutes.post(
  '/:siteKey/sessions',
  zValidator('param', siteParam, invalid('invalid path: /api/widget/<site key>/sessions')),
  zValidator('json', widgetSessionRequestSchema, invalid(SESSION_SHAPE)),
  async (c) => {
    const session = await openSession({
      siteKey: c.req.valid('param').siteKey,
      origin: c.req.header('origin'),
      address: getClientIp(c),
      request: c.req.valid('json'),
    });
    return c.json(session, 201);
  },
);

widgetRoutes.post(
  '/session/messages',
  zValidator('json', widgetMessageRequestSchema, invalid(MESSAGE_SHAPE)),
  async (c) => {
    const { session, binding } = await sessionOf(c.req.header('authorization'));
    const accepted = await sendVisitorMessage(session, binding, c.req.valid('json'));
    return c.json(accepted, 201);
  },
);

widgetRoutes.get('/session/messages', async (c) => {
  const { session, binding } = await sessionOf(c.req.header('authorization'));
  return c.json(await historyOf(session, binding));
});

widgetRoutes.get('/session/stream', async (c) => {
  const { session } = await sessionOf(c.req.header('authorization'));
  return widgetStream(c, session);
});

widgetRoutes.post(
  '/session/drafts/:draftId/confirm',
  zValidator(
    'param',
    draftParam,
    invalid('invalid path: /api/widget/session/drafts/<draft id>/confirm'),
  ),
  async (c) => {
    const { session, binding } = await sessionOf(c.req.header('authorization'));
    const filed = await confirmDraft(session, binding, c.req.valid('param').draftId);
    return c.json(filed, 201);
  },
);

widgetRoutes.post(
  '/session/drafts/:draftId/discard',
  zValidator(
    'param',
    draftParam,
    invalid('invalid path: /api/widget/session/drafts/<draft id>/discard'),
  ),
  async (c) => {
    const { session } = await sessionOf(c.req.header('authorization'));
    const draft = await discardDraft(session, c.req.valid('param').draftId);
    return c.json(draft);
  },
);
