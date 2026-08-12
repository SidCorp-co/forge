import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WEB_V2_PROFILE } from './ux-contract-presets.js';
import { type UxScanSnapshot, designSystemRuleTexts, detectDesignSystem } from './ux-stack-scan.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// packages/core/src/projects -> repo root
const REPO_ROOT = resolve(__dirname, '../../../..');
const PACKAGE_DIR = 'packages/web-v2';

function realWebV2Snapshot(): UxScanSnapshot {
  const pkgJson = JSON.parse(
    readFileSync(resolve(REPO_ROOT, PACKAGE_DIR, 'package.json'), 'utf8'),
  ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const dependencies = { ...(pkgJson.dependencies ?? {}), ...(pkgJson.devDependencies ?? {}) };

  const listing = execFileSync('git', ['ls-files', PACKAGE_DIR], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const prefix = `${PACKAGE_DIR}/`;
  const filePaths = listing
    .split('\n')
    .filter((l) => l.length > 0 && l.startsWith(prefix))
    .map((l) => l.slice(prefix.length));

  return { packageDir: PACKAGE_DIR, dependencies, filePaths };
}

describe('detectDesignSystem', () => {
  it('reproduces WEB_V2_PROFILE.designSystem from the real packages/web-v2 tree', () => {
    const snapshot = realWebV2Snapshot();
    expect(detectDesignSystem(snapshot)).toEqual(WEB_V2_PROFILE.designSystem);
  });

  it('detects shadcn/ui via components.json + a Radix dep, ownLibrary:false', () => {
    const snapshot: UxScanSnapshot = {
      packageDir: 'apps/web',
      dependencies: { '@radix-ui/react-dialog': '^1.0.0' },
      filePaths: ['components.json', 'src/components/ui/dialog.tsx'],
    };
    const result = detectDesignSystem(snapshot);
    expect(result.ownLibrary).toBe(false);
    expect(result.libraryName).toBe('Radix');
  });

  it('flags i18n:true when an i18n dependency is present', () => {
    const snapshot: UxScanSnapshot = {
      packageDir: 'apps/web',
      dependencies: { 'next-intl': '^3.0.0' },
      filePaths: [],
    };
    expect(detectDesignSystem(snapshot).i18n).toBe(true);
  });

  it('does not let lucide-react or next-themes flip ownLibrary off', () => {
    const snapshot: UxScanSnapshot = {
      packageDir: 'apps/web',
      dependencies: { 'lucide-react': '^0.5.0', 'next-themes': '^0.4.0' },
      filePaths: ['src/design/index.ts', 'src/design/primitives/skeleton.tsx'],
    };
    const result = detectDesignSystem(snapshot);
    expect(result.ownLibrary).toBe(true);
    expect(result.libraryName).toBeNull();
  });

  it('is total over an empty/garbage snapshot — no throw, all null/false/empty', () => {
    const snapshot: UxScanSnapshot = { packageDir: '.', dependencies: {}, filePaths: [] };
    expect(() => detectDesignSystem(snapshot)).not.toThrow();
    expect(detectDesignSystem(snapshot)).toEqual({
      ownLibrary: false,
      libraryName: null,
      importRoot: null,
      tokenSource: null,
      toastMechanism: null,
      i18n: false,
      breakpoints: null,
      statePrimitives: [],
    });
  });

  it('emits statePrimitives in fixed vocabulary order, not filesystem order', () => {
    const snapshot: UxScanSnapshot = {
      packageDir: 'apps/web',
      dependencies: {},
      filePaths: [
        'src/design/index.ts',
        'src/design/primitives/toast.tsx',
        'src/design/primitives/error-state.tsx',
        'src/design/primitives/skeleton.tsx',
      ],
    };
    expect(detectDesignSystem(snapshot).statePrimitives).toEqual([
      'Skeleton',
      'ErrorState',
      'Toast',
    ]);
  });

  it('detects state primitives named in PascalCase, not just kebab-case (ISS-576 review #6)', () => {
    const snapshot: UxScanSnapshot = {
      packageDir: 'apps/web',
      dependencies: {},
      filePaths: [
        'src/design/index.ts',
        'src/design/primitives/Skeleton.tsx',
        'src/design/primitives/EmptyState.tsx',
      ],
    };
    expect(detectDesignSystem(snapshot).statePrimitives).toEqual(['Skeleton', 'EmptyState']);
  });
});

describe('designSystemRuleTexts', () => {
  it('is total and returns 4 entries with orderIndex 0..3', () => {
    const texts = designSystemRuleTexts({
      ownLibrary: false,
      libraryName: null,
      importRoot: null,
      tokenSource: null,
      toastMechanism: null,
      i18n: false,
      breakpoints: null,
      statePrimitives: [],
    });
    expect(texts).toHaveLength(4);
    expect(texts.map((t) => t.orderIndex)).toEqual([0, 1, 2, 3]);
    for (const t of texts) expect(t.text.length).toBeGreaterThan(0);
  });

  it('interpolates the detected importRoot / tokenSource into the rule text', () => {
    const texts = designSystemRuleTexts(WEB_V2_PROFILE.designSystem as never);
    expect(texts[1]?.text).toContain('src/design/index.ts');
    expect(texts[2]?.text).toContain('src/styles/tokens.css');
  });
});
