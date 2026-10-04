import type { AgentSessionRefusalCode } from '@forge/contracts/agent-sessions';
import { refuser } from '../lib/refusal.js';

export const refuseSession = refuser<AgentSessionRefusalCode>('AGENT_SESSION_REFUSED');
