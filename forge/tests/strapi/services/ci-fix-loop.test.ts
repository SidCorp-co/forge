import { describe, it, expect } from 'vitest';
import { parseBuildLogs } from '../../../strapi/src/services/ci-fix-loop';

describe('parseBuildLogs', () => {
  it('parses TypeScript errors with file and line', () => {
    const logs = `
src/components/Foo.tsx(42,5): error TS2304: Cannot find name 'Bar'.
src/utils/helper.ts(10,1): error TS2307: Cannot find module './missing'.
`;
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatchObject({
      type: 'typescript',
      file: 'src/components/Foo.tsx',
      line: 42,
      message: "TS2304: Cannot find name 'Bar'.",
    });
    expect(errors[1]).toMatchObject({
      type: 'typescript',
      file: 'src/utils/helper.ts',
      line: 10,
    });
  });

  it('parses TypeScript errors without file path', () => {
    const logs = 'error TS2345: Argument of type string is not assignable';
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('typescript');
    expect(errors[0].message).toContain('TS2345');
  });

  it('parses Module not found errors', () => {
    const logs = "Module not found: Can't resolve '@/components/Missing'";
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('module_not_found');
  });

  it('parses Cannot find module errors', () => {
    const logs = "Cannot find module './foo/bar'";
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('module_not_found');
    expect(errors[0].message).toContain('./foo/bar');
  });

  it('parses Docker build errors', () => {
    const logs = 'ERROR [build 3/5] RUN npm run build';
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('docker');
  });

  it('parses failed to solve errors', () => {
    const logs = 'failed to solve: process "/bin/sh -c npm run build" did not complete';
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('docker');
  });

  it('parses npm errors', () => {
    const logs = 'npm ERR! code ELIFECYCLE\nnpm ERR! Exit status 1';
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(2);
    expect(errors[0].type).toBe('npm');
    expect(errors[1].type).toBe('npm');
  });

  it('deduplicates identical errors', () => {
    const logs = `
error TS2304: Cannot find name 'Foo'.
error TS2304: Cannot find name 'Foo'.
error TS2304: Cannot find name 'Foo'.
`;
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(1);
  });

  it('limits to 10 errors max', () => {
    const lines = Array.from({ length: 20 }, (_, i) =>
      `src/file${i}.ts(1,1): error TS${2300 + i}: Error ${i}`,
    ).join('\n');
    const errors = parseBuildLogs(lines);
    expect(errors).toHaveLength(10);
  });

  it('truncates raw field to 500 chars', () => {
    const longLine = `error TS2345: ${'x'.repeat(600)}`;
    const errors = parseBuildLogs(longLine);
    expect(errors).toHaveLength(1);
    expect(errors[0].raw.length).toBeLessThanOrEqual(500);
  });

  it('returns empty array for empty input', () => {
    expect(parseBuildLogs('')).toEqual([]);
    expect(parseBuildLogs('   \n   ')).toEqual([]);
  });

  it('handles mixed error types', () => {
    const logs = `
src/app.tsx(5,1): error TS2304: Missing type
Module not found: Can't resolve 'lodash'
npm ERR! code ELIFECYCLE
ERROR [build 2/3] RUN npm ci
`;
    const errors = parseBuildLogs(logs);
    expect(errors).toHaveLength(4);
    const types = errors.map(e => e.type);
    expect(types).toContain('typescript');
    expect(types).toContain('module_not_found');
    expect(types).toContain('npm');
    expect(types).toContain('docker');
  });
});
