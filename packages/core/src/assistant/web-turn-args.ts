// What a Forge UI turn is handed: its project, its asker and the window it answers.

import type { ConversationImage, ConversationVenue } from '../conversations/index.js';
import type { ConversationMode } from '../db/schema-conversations.js';
import type { ConversationProgress } from './conversation-progress.js';

/** A Forge UI turn's project, asker, window and watcher. */
export interface WebTurnArgs {
  project: { id: string; slug: string; name: string };
  handleName: string;
  askedBy: string | null;
  /** The window this turn answers, for the diversion that answers later. */
  window: {
    venue: ConversationVenue;
    conversationId: string;
    windowId: string;
    deliveryKey: string;
    mode: ConversationMode;
    question: string;
    /** The pictures this window's messages carry, for a turn answered on a box. */
    images: readonly ConversationImage[];
    /**
     * What was said in this room BEFORE this window, for a turn answered out of reach.
     */
    conversationContext: () => Promise<string | null>;
    reserve: () => Promise<boolean>;
  };
  /**
   * The watcher this turn publishes to while it runs.
   */
  progress: ConversationProgress;
  /** A person ending this turn from the room it runs in. */
  externalStop: AbortSignal;
}
