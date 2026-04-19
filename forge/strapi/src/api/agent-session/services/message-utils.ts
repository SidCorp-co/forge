import type { ContentBlock } from './stream-accumulator';

/** Update or append the assistant message in the messages array. */
export function upsertAssistantMessage(
  messages: any[],
  text: string,
  toolCalls: any[] | undefined,
  contentBlocks: ContentBlock[] | undefined,
  opts?: { streaming?: boolean },
) {
  const lastMsg = messages[messages.length - 1];
  const tcValue = toolCalls?.length ? toolCalls : undefined;
  const cbValue = contentBlocks?.length ? contentBlocks : undefined;

  if (lastMsg?.role === 'assistant' && lastMsg?._streaming) {
    lastMsg.content = text;
    lastMsg.toolCalls = tcValue;
    lastMsg.contentBlocks = cbValue;
    lastMsg.timestamp = Date.now();
    if (!opts?.streaming) delete lastMsg._streaming;
  } else if (text || tcValue) {
    const msg: any = {
      role: 'assistant',
      content: text,
      toolCalls: tcValue,
      contentBlocks: cbValue,
      timestamp: Date.now(),
    };
    if (opts?.streaming) msg._streaming = true;
    messages.push(msg);
  }
}
