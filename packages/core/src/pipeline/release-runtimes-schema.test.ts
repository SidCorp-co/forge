import { describe, expect, it } from 'vitest';
import { pipelineConfigSchema, releaseRuntimesSchema } from './pipeline-config-schema.js';

const runner = (paths: string[], extra: Record<string, unknown> = {}) => ({
  name: 'runner',
  paths,
  servedBy: 'project-runners',
  ...extra,
});

function refusal(value: unknown): string {
  const parsed = releaseRuntimesSchema.safeParse(value);
  expect(parsed.success).toBe(false);
  return parsed.success ? '' : parsed.error.issues.map((i) => i.message).join('\n');
}

describe('pipelineConfig.releaseRuntimes (ISS-1368)', () => {
  it('accepts a runner runtime, and leaves a document without the key as it was', () => {
    const declared = [runner(['packages/runner'])];
    expect(pipelineConfigSchema.parse({ releaseRuntimes: declared }).releaseRuntimes).toEqual(
      declared,
    );
    expect('releaseRuntimes' in pipelineConfigSchema.parse({ enabled: true })).toBe(false);
  });

  it('accepts two runtimes whose paths only share a spelling, not a segment', () => {
    const declared = [
      runner(['packages/runner']),
      { name: 'run', paths: ['packages/run'], servedBy: 'project-runners' },
    ];
    expect(releaseRuntimesSchema.safeParse(declared).success).toBe(true);
  });

  it('accepts one runtime naming a path and a path under it', () => {
    expect(
      releaseRuntimesSchema.safeParse([runner(['packages/runner', 'packages/runner/crates'])])
        .success,
    ).toBe(true);
  });

  it.each([
    ['an absolute path', ['/packages/runner']],
    ['a ./ path', ['./packages/runner']],
    ['a .. segment', ['packages/../runner']],
    ['an empty segment', ['packages//runner']],
    ['a wildcard', ['packages/runner/**']],
    ['an empty path', ['']],
  ])('refuses %s, naming the valid shape', (_shape, paths) => {
    expect(refusal([runner(paths)])).toContain('a path relative to the repository root');
  });

  it('refuses two runtimes claiming one path, whichever spelling each uses', () => {
    const said = refusal([
      runner(['packages/runner']),
      { name: 'daemon', paths: ['packages/runner/'], servedBy: 'project-runners' },
    ]);
    expect(said).toContain(
      '`packages/runner/` overlaps `packages/runner/`, which `runner` already claims',
    );
  });

  it('refuses a runtime claiming a path inside another runtime', () => {
    const said = refusal([
      runner(['packages/runner']),
      { name: 'crates', paths: ['packages/runner/crates'], servedBy: 'project-runners' },
    ]);
    expect(said).toContain('overlaps');
  });

  it('refuses a repeated name, the reserved name and an unknown servedBy', () => {
    expect(refusal([runner(['a']), runner(['b'])])).toContain(
      'two release runtimes are named `runner`',
    );
    expect(refusal([runner(['a'], { name: 'deployment' })])).toContain(
      '`deployment` names the runtime',
    );
    expect(refusal([runner(['a'], { servedBy: 'probes' })])).toMatch(/project-runners/);
    expect(refusal([runner(['a'], { extra: true })])).toMatch(/extra/);
  });
});
