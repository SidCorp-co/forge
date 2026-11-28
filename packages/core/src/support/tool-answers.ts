// The pieces of forge_support's answer and input that need no schema (split from `tool.ts`).

import { markUntrusted } from '../lib/untrusted-text.js';
import type { ImageRead } from './images.js';

/**
 * A picture as `uploads.read` hands one (ISS-532): its name and type framed as data, then the image
 * block the model views; the structured answer names the block and repeats no bytes.
 */
export function imageAnswer(read: ImageRead): Record<string, unknown> {
  // the name is the writer's: it rides only inside the data frame
  const { dataBase64, name: _name, ...meta } = read;
  return {
    _mcpContent: [
      {
        type: 'text',
        text: markUntrusted(`Image name="${read.name}" mime="${read.mime}".`, {
          source: 'support group member picture',
        }),
      },
      { type: 'image', data: dataBase64, mimeType: read.mime },
    ],
    ...meta,
    image: { contentIndex: 1, mimeType: read.mime },
    note: 'The picture is content block 1, which this structured answer does not repeat.',
  };
}

export function withoutAction(input: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, rid: _rid, ...rest } = input;
  return rest;
}
