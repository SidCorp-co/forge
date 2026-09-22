/**
 * ISS-1189 — what `{{project:test-urls}}` tells a run about where to exercise a change.
 *
 * The `local` line is the point. Before the declaration existed, a project with no preview side
 * produced no Preview line at all, which reads exactly like a project whose preview host is merely
 * unset — and a run reading that silence has no way to tell "exercise it here" from "wait".
 */

import { describe, expect, it } from 'vitest';
import { normalizeEnvironments } from '../../projects/environments.js';
import { renderTestUrls } from './environment-keys.js';

const LIVE_ONLY = normalizeEnvironments({
  preview: null,
  live: { url: 'https://app.example.com', apiUrl: 'https://api.example.com' },
});

const WITH_PREVIEW = normalizeEnvironments({
  preview: { url: 'https://staging.example.com' },
  live: { url: 'https://app.example.com' },
});

describe('a project that declares a local preview', () => {
  it('is told its preview is local rather than told nothing', () => {
    expect(renderTestUrls(LIVE_ONLY, 'local')).toContain('Preview: local');
  });

  it('is told where to exercise a criterion that needs the running product', () => {
    expect(renderTestUrls(LIVE_ONLY, 'local')).toContain("this run's own worktree");
  });

  it('still gets the live side, which is a different address and a different act', () => {
    expect(renderTestUrls(LIVE_ONLY, 'local')).toContain('- Live: https://app.example.com');
  });
});

describe('a project that declares a deployed preview', () => {
  it('gets the preview host and no local line', () => {
    const out = renderTestUrls(WITH_PREVIEW, 'deployed') ?? '';
    expect(out).toContain('- Preview: https://staging.example.com');
    expect(out).not.toContain('Preview: local');
  });
});
