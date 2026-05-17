import { describe, expect, it } from 'vitest';
import {
  CLIENTS,
  TOKEN_PLACEHOLDER,
  generateSnippet,
  getMcpUrl,
} from '@/features/mcp/lib/snippet-generators';

const URL = 'https://forge.example.com/mcp';
const SLUG = 'acme-prod';
const TOKEN = 'forge_pat_live_a1b2c3d4e5f6';

describe('generateSnippet', () => {
  it('embeds the plaintext token, slug, and url for every client', () => {
    for (const { kind } of CLIENTS) {
      const snippet = generateSnippet(kind, {
        tokenPlaintext: TOKEN,
        projectSlug: SLUG,
        mcpUrl: URL,
      });
      expect(snippet.content).toContain(`Bearer ${TOKEN}`);
      expect(snippet.content).toContain(SLUG);
      expect(snippet.content).toContain(URL);
      expect(snippet.placeholderToken).toBe(false);
      expect(snippet.content).toContain('forge');
      // Output must be valid JSON.
      expect(() => JSON.parse(snippet.content)).not.toThrow();
    }
  });

  it('substitutes <YOUR_TOKEN_HERE> when plaintext is unavailable', () => {
    const s = generateSnippet('claude-cli', {
      tokenPlaintext: null,
      projectSlug: SLUG,
      mcpUrl: URL,
    });
    expect(s.content).toContain(TOKEN_PLACEHOLDER);
    expect(s.placeholderToken).toBe(true);
  });

  it('uses the canonical file path per client', () => {
    expect(generateSnippet('claude-cli', { tokenPlaintext: TOKEN, projectSlug: SLUG, mcpUrl: URL }).filePath).toBe('~/.claude/settings.json');
    expect(generateSnippet('cursor', { tokenPlaintext: TOKEN, projectSlug: SLUG, mcpUrl: URL }).filePath).toBe('.cursor/mcp.json');
    expect(generateSnippet('cline', { tokenPlaintext: TOKEN, projectSlug: SLUG, mcpUrl: URL }).filePath).toBe('cline_mcp_settings.json');
    expect(generateSnippet('zed', { tokenPlaintext: TOKEN, projectSlug: SLUG, mcpUrl: URL }).filePath).toBe('~/.config/zed/settings.json');
    expect(generateSnippet('generic', { tokenPlaintext: TOKEN, projectSlug: SLUG, mcpUrl: URL }).filePath).toBe('mcp.json');
  });

  it('uses context_servers shape for Zed', () => {
    const s = generateSnippet('zed', {
      tokenPlaintext: TOKEN,
      projectSlug: SLUG,
      mcpUrl: URL,
    });
    const parsed = JSON.parse(s.content) as { context_servers: { forge: unknown } };
    expect(parsed.context_servers).toBeDefined();
    expect(parsed.context_servers.forge).toBeDefined();
  });

  it('uses mcpServers shape for non-Zed clients', () => {
    for (const kind of ['claude-cli', 'cursor', 'cline', 'generic'] as const) {
      const s = generateSnippet(kind, {
        tokenPlaintext: TOKEN,
        projectSlug: SLUG,
        mcpUrl: URL,
      });
      const parsed = JSON.parse(s.content) as { mcpServers: { forge: unknown } };
      expect(parsed.mcpServers).toBeDefined();
      expect(parsed.mcpServers.forge).toBeDefined();
    }
  });
});

describe('getMcpUrl', () => {
  it('derives /mcp from NEXT_PUBLIC_API_URL', () => {
    const original = process.env.NEXT_PUBLIC_API_URL;
    process.env.NEXT_PUBLIC_API_URL = 'https://forge.example.com/api';
    expect(getMcpUrl()).toBe('https://forge.example.com/mcp');
    process.env.NEXT_PUBLIC_API_URL = 'https://forge.example.com/api/';
    expect(getMcpUrl()).toBe('https://forge.example.com/mcp');
    if (original === undefined) delete process.env.NEXT_PUBLIC_API_URL;
    else process.env.NEXT_PUBLIC_API_URL = original;
  });

  it('falls back to localhost when env is unset', () => {
    const original = process.env.NEXT_PUBLIC_API_URL;
    delete process.env.NEXT_PUBLIC_API_URL;
    expect(getMcpUrl()).toBe('http://localhost:8080/mcp');
    if (original !== undefined) process.env.NEXT_PUBLIC_API_URL = original;
  });
});
