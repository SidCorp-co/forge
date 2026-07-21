/**
 * ISS-727 — per-project RC bot answer-mode knob. Read from
 * `agentConfig.rocketChatAnswerMode` (mirrors the `personaStyle` sub-key
 * convention — see `chat/system-prompt.ts`'s `readAgentConfigString`).
 *
 * `fast` (default, absent/anything-else): unchanged provider-chat path.
 * `agent`: every real turn routes through a runner-hosted Claude session
 * instead (`agent-chat.ts`).
 */
export type RocketChatAnswerMode = 'fast' | 'agent';

export function readRocketChatAnswerMode(agentConfig: unknown): RocketChatAnswerMode {
  if (!agentConfig || typeof agentConfig !== 'object') return 'fast';
  const value = (agentConfig as Record<string, unknown>).rocketChatAnswerMode;
  return value === 'agent' ? 'agent' : 'fast';
}
