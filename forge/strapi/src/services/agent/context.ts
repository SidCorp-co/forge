import type { Message } from './provider';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function messageTokens(msg: Message): number {
  if (typeof msg.content === 'string') {
    return estimateTokens(msg.content);
  }
  return estimateTokens(JSON.stringify(msg.content));
}

export function buildContextMessages(params: {
  systemPrompt: string;
  history: Message[];
  newMessage: Message;
  maxTokens: number;
  reserveForResponse: number;
}): Message[] {
  const budget = params.maxTokens - params.reserveForResponse;
  const systemTokens = estimateTokens(params.systemPrompt);
  const newMsgTokens = messageTokens(params.newMessage);
  let remaining = budget - systemTokens - newMsgTokens;

  const kept: Message[] = [];
  for (let i = params.history.length - 1; i >= 0; i--) {
    const cost = messageTokens(params.history[i]);
    if (remaining - cost < 0) break;
    remaining -= cost;
    kept.unshift(params.history[i]);
  }

  return [...kept, params.newMessage];
}
