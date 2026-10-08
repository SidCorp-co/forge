import type { CoreGuide } from './types.js';

/** The one spelling of this guide's slug. Every door persona points at it. */
const ASSISTANT_METHOD_SLUG = 'answering-as-the-assistant';

let methodBody: string | null = null;

/**
 * The assistant (Conversations) owns its method, and guides sits upstream of it, so the
 * composition root hands the composed method in at boot.
 */
export function provideAssistantMethod(body: string): void {
  methodBody = body;
}

export const ASSISTANT_METHOD_GUIDE: CoreGuide = {
  slug: ASSISTANT_METHOD_SLUG,
  audience: 'agent',
  title: 'Answering as the assistant',
  summary:
    'How a Forge assistant works a request: investigate with your tools before answering, route a report or a wish to Feedback or a Requirement (never an issue), confirm before writing, and what a reply and a record owe.',
  version: 3,
  get body(): string {
    if (methodBody === null) {
      throw new Error(
        'guides: the assistant method was not provided, so its guide has no body; the process entry calls provideAssistantMethod before it serves',
      );
    }
    return methodBody;
  },
};
