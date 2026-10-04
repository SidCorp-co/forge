import { SESSION_SILENCE_REAP_MS } from '@forge/contracts/run-standing';

export const SESSION_SILENCE_TIMEOUT_MS = SESSION_SILENCE_REAP_MS;

export const SESSION_SILENCE_TIMEOUT_S = Math.floor(SESSION_SILENCE_TIMEOUT_MS / 1000);
