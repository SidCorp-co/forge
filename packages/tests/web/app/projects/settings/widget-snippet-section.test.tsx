import { describe, it, expect } from 'vitest';
import { generateSnippet } from '@/app/projects/[slug]/settings/components/widget-snippet-section';

describe('generateSnippet', () => {
  it('emits /api/widget/<slug>/forge-widget.js URL', () => {
    const snippet = generateSnippet({
      apiKey: 'fk_test',
      apiUrl: 'https://example.com/api',
      position: 'bottom-right',
      themeColor: 'var(--color-info)',
      projectName: 'ApiFlow',
      projectSlug: 'apiflow',
    });

    expect(snippet).toContain('src="https://example.com/api/widget/apiflow/forge-widget.js"');
    expect(snippet).toMatch(/^<script /);
    expect(snippet).toContain('async></script>');
    expect(snippet).toMatch(/data-config="[^"]+"/);
  });

  it('encodes apiKey, position, and themeColor in base64 data-config', () => {
    const snippet = generateSnippet({
      apiKey: 'fk_test',
      apiUrl: 'https://example.com/api',
      position: 'bottom-left',
      themeColor: 'var(--color-success)',
      projectName: 'ApiFlow',
      projectSlug: 'apiflow',
    });

    const match = snippet.match(/data-config="([^"]+)"/);
    expect(match).not.toBeNull();
    const decoded = JSON.parse(atob(match![1]));
    expect(decoded).toEqual({
      k: 'fk_test',
      p: 'bottom-left',
      c: 'var(--color-success)',
    });
  });

  it('preserves trailing /api in apiUrl when building the bundle URL', () => {
    const snippet = generateSnippet({
      apiKey: 'fk_test',
      apiUrl: 'https://example.com/api',
      position: 'bottom-right',
      themeColor: 'var(--color-info)',
      projectName: 'ApiFlow',
      projectSlug: 'apiflow',
    });

    expect(snippet).toContain('https://example.com/api/widget/apiflow/forge-widget.js');
  });
});
