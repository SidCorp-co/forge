import { describe, expect, it } from 'vitest';
import { openAiCompatUrl } from './openai-compat-url.js';

describe('openAiCompatUrl', () => {
  it('reads the host form, the /v1 form and trailing slashes as the same endpoint', () => {
    for (const base of [
      'https://proxy.test',
      'https://proxy.test/',
      'https://proxy.test/v1',
      'https://proxy.test/v1/',
      'https://proxy.test//',
    ]) {
      expect(openAiCompatUrl(base, 'chat/completions')).toBe(
        'https://proxy.test/v1/chat/completions',
      );
    }
    expect(openAiCompatUrl('https://an.test/v1', 'messages')).toBe('https://an.test/v1/messages');
  });

  it('does not eat a path segment that merely ends in v1', () => {
    expect(openAiCompatUrl('https://proxy.test/tenantv1', 'embeddings')).toBe(
      'https://proxy.test/tenantv1/v1/embeddings',
    );
  });
});
