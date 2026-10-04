import type { ConversationRefusalCode } from '@forge/contracts/conversations';
import { refuser } from '../lib/refusal.js';

export const refuseConversation = refuser<ConversationRefusalCode>('CONVERSATION_REFUSED');
