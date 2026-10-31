// @direct-test-of packages/core/src/release-batch/coolify-commands.ts
// ISS-836: RELEASE_NOTHING_RECORDED names the call it asks for whole: the route with this run's
// ids, and the body that route takes, `skill` included. An elided route left the agent guessing.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../db/client.js', () => ({ db: {} }));

const { releaseDeployBeforeRecording } = await import('./coolify-commands.js');

describe('a release deploy refused before the run recorded anything', () => {
  const said = releaseDeployBeforeRecording('p-1', 'r-2');

  it('names the method route with this project and run filled in', () => {
    expect(said).toContain('POST /api/projects/p-1/release-batches/r-2/method');
    expect(said).not.toContain('...');
  });

  it('names the body the route takes, skill and loaded included', () => {
    expect(said).toContain('"skill"');
    expect(said).toContain('"loaded"');
    expect(said).toContain('"detail"');
  });
});
