import { describe, expect, it, vi } from 'vitest';

vi.mock('../config/env.js', () => ({
  env: { APP_BASE_URL: 'https://forge.example.com/', NODE_ENV: 'test' },
}));

const { forgeMcpInstructions, publicGuidesUrl } = await import('./instructions.js');

describe('the MCP instruction block', () => {
  it('names the public guides page on the web host', () => {
    expect(publicGuidesUrl()).toBe('https://forge.example.com/guides');
    expect(forgeMcpInstructions()).toContain('https://forge.example.com/guides');
  });

  it('says the corpus needs no credential, so an agent does not assume it is gated', () => {
    expect(forgeMcpInstructions()).toMatch(/public and needs no credential/);
  });

  it('keeps the markdown pointer, which is what a machine reader fetches', () => {
    expect(forgeMcpInstructions()).toContain('/api/guides/<slug>.md');
  });
});
