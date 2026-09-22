/**
 * ISS-1189 — the preview shape is declared, and a configuration that contradicts the declaration
 * is refused rather than stored.
 *
 * The blob in `FORGE_DEV_BEFORE_THE_FIX` is not invented. It is what forge-dev carried until
 * 2026-09-22: a preview side pointing at the same two addresses as live, labelled "Beta Version
 * (Staging Here)". Every reader that asked whether the project had a preview was told yes by it,
 * and nothing anywhere said the two sides named one host.
 */

import { describe, expect, it } from 'vitest';
import { normalizeEnvironments } from './environments.js';
import {
  PREVIEW_IS_LIVE_HOST,
  PREVIEW_SHAPE_DEPLOYED_WITHOUT_HOST,
  PREVIEW_SHAPE_LOCAL_WITH_HOST,
  shapeGapOf,
} from './release-shape.js';

const FORGE_DEV_BEFORE_THE_FIX = {
  preview: {
    url: 'https://forge-beta.sidcorp.co',
    apiUrl: 'https://forge-beta-api.sidcorp.co',
    urls: [{ label: 'Beta Version (Staging Here)', url: 'https://forge-beta.sidcorp.co' }],
  },
  live: {
    url: 'https://forge-beta.sidcorp.co',
    apiUrl: 'https://forge-beta-api.sidcorp.co',
    commitUrl: 'https://forge-beta-api.sidcorp.co/health',
    commitPath: 'sourceCommit',
  },
};

const A_REAL_PREVIEW = {
  preview: { url: 'https://staging.example.com', apiUrl: 'https://api.staging.example.com' },
  live: { url: 'https://app.example.com', apiUrl: 'https://api.example.com' },
};

const NO_PREVIEW = {
  preview: null,
  live: { url: 'https://app.example.com', apiUrl: 'https://api.example.com' },
};

describe('a preview side naming live’s host is refused rather than stored', () => {
  it('refuses forge-dev’s pre-fix blob by name', () => {
    const gap = shapeGapOf('deployed', normalizeEnvironments(FORGE_DEV_BEFORE_THE_FIX));
    expect(gap?.code).toBe(PREVIEW_IS_LIVE_HOST);
  });

  it('names the host the two sides share, so the reader knows which line to delete', () => {
    const gap = shapeGapOf('deployed', normalizeEnvironments(FORGE_DEV_BEFORE_THE_FIX));
    expect(gap?.message).toContain('forge-beta.sidcorp.co');
  });

  it('refuses it under the other declaration too — the collision is the defect, not the shape', () => {
    const gap = shapeGapOf('local', normalizeEnvironments(FORGE_DEV_BEFORE_THE_FIX));
    expect(gap?.code).toBe(PREVIEW_IS_LIVE_HOST);
  });

  it('catches a collision carried only by a labelled testing URL', () => {
    const env = normalizeEnvironments({
      preview: {
        url: 'https://staging.example.com',
        urls: [{ label: 'Staging Here', url: 'https://app.example.com/admin' }],
      },
      live: { url: 'https://app.example.com' },
    });
    expect(shapeGapOf('deployed', env)?.code).toBe(PREVIEW_IS_LIVE_HOST);
  });

  it('leaves a preview side on its own host alone', () => {
    expect(shapeGapOf('deployed', normalizeEnvironments(A_REAL_PREVIEW))).toBeNull();
  });
});

describe('the declaration and the stored blob may not disagree', () => {
  it('refuses `local` beside a preview side that names a host', () => {
    const gap = shapeGapOf('local', normalizeEnvironments(A_REAL_PREVIEW));
    expect(gap?.code).toBe(PREVIEW_SHAPE_LOCAL_WITH_HOST);
  });

  it('refuses `deployed` beside no preview side at all', () => {
    const gap = shapeGapOf('deployed', normalizeEnvironments(NO_PREVIEW));
    expect(gap?.code).toBe(PREVIEW_SHAPE_DEPLOYED_WITHOUT_HOST);
  });

  it('accepts `local` beside no preview side, which is the normal one-box shape', () => {
    expect(shapeGapOf('local', normalizeEnvironments(NO_PREVIEW))).toBeNull();
  });
});
