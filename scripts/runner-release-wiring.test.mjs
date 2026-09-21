import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Read as text, the way conformance-audit.mjs reads these files: the subject is
// which literal declarations are present, and a parse adds a dependency without
// making the assertions any sharper.
const root = join(import.meta.dirname, '..');
const workflow = (name) => readFileSync(join(root, '.github/workflows', name), 'utf8');
const AUTO = workflow('runner-autorelease.yml');
const RELEASE = workflow('runner-release.yml');

describe('runner-autorelease — what starts a release', () => {
  it('runs on a push to the default branch', () => {
    expect(AUTO).toMatch(/on:\s*\n\s*push:\s*\n\s*branches:\s*\[main\]/);
  });

  it('runs only for a change under the runner package', () => {
    expect(AUTO).toMatch(/paths:\s*\n\s*- "packages\/runner\/\*\*"/);
  });

  it('takes the version from the one script that decides it', () => {
    expect(AUTO).toContain('node scripts/next-runner-version.mjs');
  });

  it('cuts the tag through the script that refuses one that exists', () => {
    expect(AUTO).toContain('node scripts/cut-runner-tag.mjs');
  });

  it('never forces the tag from the workflow itself', () => {
    expect(AUTO).not.toMatch(/git\s+(tag|push)[^\n]*(--force|-f\b)/);
  });

  it('serialises its runs, so two merges cannot compute one version in parallel', () => {
    expect(AUTO).toMatch(/concurrency:\s*\n\s*group: runner-autorelease/);
  });
});

describe('runner-autorelease — how the release is reached', () => {
  // The load-bearing one. A tag pushed with the workflow's own GITHUB_TOKEN starts
  // no workflow run, so a release reached by tag-push alone would publish nothing
  // and say nothing — the silence ISS-1165 exists to close.
  it('calls the release workflow rather than relying on the tag push to trigger it', () => {
    expect(AUTO).toMatch(/uses: \.\/\.github\/workflows\/runner-release\.yml/);
  });

  it('hands the release the version it just tagged, and the commit', () => {
    expect(AUTO).toMatch(/with:\s*\n\s*version: \$\{\{ needs\.tag\.outputs\.version \}\}/);
    expect(AUTO).toMatch(/sha: \$\{\{ github\.sha \}\}/);
  });

  it('grants the called workflow the permission a release needs', () => {
    expect(AUTO).toMatch(/release:\s*\n\s*needs: tag\s*\n\s*permissions:\s*\n\s*contents: write/);
  });
});

describe('runner-release — what a release carries', () => {
  it('can be called, with the version and the commit as inputs', () => {
    expect(RELEASE).toMatch(/workflow_call:\s*\n\s*inputs:/);
    expect(RELEASE).toMatch(/\n {6}version:\n/);
    expect(RELEASE).toMatch(/\n {6}sha:\n/);
  });

  it('still releases a tag cut by hand', () => {
    expect(RELEASE).toMatch(/push:\s*\n\s*tags:\s*\n\s*- "runner-v\*"/);
  });

  it("stamps the released version into the binary rather than taking Cargo's", () => {
    expect(RELEASE).toMatch(/FORGE_RUNNER_VERSION: \$\{\{ needs\.resolve\.outputs\.version \}\}/);
  });

  it('stamps the commit it built into the binary', () => {
    expect(RELEASE).toMatch(/FORGE_RUNNER_COMMIT: \$\{\{ needs\.resolve\.outputs\.sha \}\}/);
  });

  it('publishes the commit beside the version, which is what core compares against', () => {
    expect(RELEASE).toContain('dist/COMMIT');
    expect(RELEASE).toContain('dist/VERSION');
  });

  it('builds and releases only after the same gates the merge gate runs', () => {
    expect(RELEASE).toMatch(/build:\s*\n\s*needs: \[resolve, check\]/);
    expect(RELEASE).toMatch(/cargo fmt --check/);
    expect(RELEASE).toMatch(/cargo test --workspace/);
  });

  it('checks out the commit being released rather than whatever the ref points at', () => {
    const checkouts = [...RELEASE.matchAll(/ref: \$\{\{ needs\.resolve\.outputs\.sha \}\}/g)];
    expect(checkouts.length).toBe(2);
  });
});
