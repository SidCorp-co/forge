import type { AssistantRefusalCode } from '@forge/contracts/assistant';
import { refuser } from '../lib/refusal.js';

export const refuseAssistant = refuser<AssistantRefusalCode>('ASSISTANT_REFUSED');
