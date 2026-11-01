// ISS-867: the provider is OpenAI-compatible without structured outputs, so it is sent JSON mode and
// never the schema. A typed call therefore ends its prompt with the answer's shape read off the schema;
// without it the model guessed field names, the schema refused them, and the answer was dropped.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const sent = vi.hoisted(() => ({ prompts: [] as string[], answer: {} as unknown }));

vi.mock('ai', async (importOriginal) => {
  const real = await importOriginal<typeof import('ai')>();
  return {
    ...real,
    generateText: async (args: { prompt: string }) => {
      sent.prompts.push(args.prompt);
      return { output: sent.answer, response: { modelId: 'test-fast' } };
    },
  };
});
vi.mock('../../lib/env.js', () => ({
  env: { LITELLM_API_URL: 'http://fast.test', LITELLM_MODEL: 'test-fast' },
}));
vi.mock('../../lib/data-egress.js', () => ({
  egressScoped: async (_scope: unknown, text: string) => ({ ok: true, text }),
}));

const { answerShapeLine, callFastModelObject } = await import('./fast-model.js');

const schema = z.object({
  verdict: z.enum(['keep', 'drop']),
  items: z.array(z.object({ ref: z.string(), why: z.string().nullish() })).default([]),
});

describe('a typed fast-model prompt states its answer shape (ISS-867)', () => {
  beforeEach(() => {
    sent.prompts.length = 0;
    sent.answer = { verdict: 'keep', items: [] };
  });

  it('sends the prompt with the shape appended, naming every field, nested ones included', async () => {
    const out = await callFastModelObject({ surface: 'lessons' } as never, 'Judge it.', schema, {
      maxTokens: 100,
    });
    expect(out.ok).toBe(true);
    expect(sent.prompts).toHaveLength(1);
    const [prompt] = sent.prompts as [string];
    expect(prompt.startsWith('Judge it.\n\n')).toBe(true);
    expect(prompt.endsWith(answerShapeLine(schema))).toBe(true);
    for (const field of ['verdict', 'items', 'ref', 'why', '"keep"', '"drop"'])
      expect(prompt).toContain(field);
  });

  it('marks a field the answer may leave out with ?', () => {
    expect(answerShapeLine(schema)).toContain('items?:');
    expect(answerShapeLine(schema)).toContain('why?:');
    expect(answerShapeLine(schema)).toContain('verdict:');
  });
});
