import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({ db: {} }));

const { namespaceFromServerUrl } = await import('./directory.js');

describe('namespaceFromServerUrl', () => {
  it('reduces the spellings of one installation to one namespace', () => {
    const spellings = [
      'https://chat.example.com',
      'https://chat.example.com/',
      'https://CHAT.example.com',
      'https://chat.example.com/some/path',
    ];
    expect(new Set(spellings.map(namespaceFromServerUrl)).size).toBe(1);
    expect(namespaceFromServerUrl(spellings[0] as string)).toBe('chat.example.com');
  });

  it('keeps the port, because two installations can share a host', () => {
    expect(namespaceFromServerUrl('https://chat.example.com:8443')).toBe('chat.example.com:8443');
    expect(namespaceFromServerUrl('https://chat.example.com:8443')).not.toBe(
      namespaceFromServerUrl('https://chat.example.com'),
    );
  });

  it('returns null rather than a namespace it invented', () => {
    expect(namespaceFromServerUrl('')).toBeNull();
    expect(namespaceFromServerUrl('chat.example.com')).toBeNull();
  });
});
