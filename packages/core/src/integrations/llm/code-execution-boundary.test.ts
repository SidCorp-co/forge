import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The provider's code execution tool, its wire blocks and the adapter's id are named in
// integrations/llm and nowhere else in production code: the reports domain, the assistant, the
// contracts and web know only the Executor port (REQ-32 ADR, "Port 4 — Executor").

const PACKAGES = fileURLToPath(new URL('../../../../', import.meta.url));
const ROOTS = ['core/src', 'contracts/src', 'web-v2/src'];
const HOME = `core${sep}src${sep}integrations${sep}llm${sep}`;
const VENDOR =
  /code_execution_20\d{6}|container_upload|bash_code_execution|server_tool_use|anthropic-code-exec|\/v1\/files/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('the code execution vendor stays inside integrations/llm', () => {
  it('is named by no production file outside it', () => {
    const leaks = ROOTS.flatMap((root) => sources(join(PACKAGES, root)))
      .map((path) => relative(PACKAGES, path))
      .filter((path) => !path.startsWith(HOME))
      .filter((path) => VENDOR.test(readFileSync(join(PACKAGES, path), 'utf8')));
    expect(leaks).toEqual([]);
  });

  it('is named inside it, so the scan reads the files it means to', () => {
    const home = sources(join(PACKAGES, HOME)).filter((path) =>
      VENDOR.test(readFileSync(path, 'utf8')),
    );
    expect(home.map((path) => relative(PACKAGES, path)).sort()).toEqual([
      `${HOME}code-execution-wire.ts`,
      `${HOME}code-execution.ts`,
    ]);
  });
});
