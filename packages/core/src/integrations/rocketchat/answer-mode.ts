export type RocketChatAnswerMode = 'fast' | 'agent';

export function readRocketChatAnswerMode(agentConfig: unknown): RocketChatAnswerMode {
  if (!agentConfig || typeof agentConfig !== 'object') return 'fast';
  const value = (agentConfig as Record<string, unknown>).rocketChatAnswerMode;
  return value === 'agent' ? 'agent' : 'fast';
}
