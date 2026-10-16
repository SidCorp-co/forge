// A visitor's private status link: what they may know of what they filed, and nothing more — the
// item's key and title as they confirmed it, one of five phases and one plain sentence.

import type { WidgetStatus } from '@forge/contracts/widget';
import { externalFeedbackStatus } from '../feedback/index.js';
import { refuse } from './refuse.js';
import { visitorStatusOf } from './rules.js';
import { statusTokenHash } from './tokens.js';

export async function statusOfLink(token: string): Promise<WidgetStatus> {
  const hash = statusTokenHash(token);
  const item = hash ? await externalFeedbackStatus(hash) : null;
  if (!item) {
    throw refuse(
      'WIDGET_STATUS_UNKNOWN',
      'this status link names no report; check that the link was copied whole',
      '/token',
    );
  }
  return {
    feedbackKey: item.key,
    title: item.title,
    ...visitorStatusOf(item),
    filedAt: item.filedAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
  };
}
