import { basename, dirname } from 'node:path';
import type { UxStackProfile } from './ux-contract-presets.js';

// ISS-576 — deterministic §1 (design-system) detection. Pure function over a
// {packageDir, dependencies, filePaths} snapshot (collected on the runner,
// which has the checkout — core has none); total and order-independent so a
// scan is reproducible and diffable across runs. See `ux-stack-apply.ts` for
// the persistence/drift side.

export interface UxScanSnapshot {
  /** repo-relative package dir, e.g. 'packages/web-v2' (no trailing slash). */
  packageDir: string;
  /** merged `dependencies` + `devDependencies` of that package's package.json. */
  dependencies: Record<string, string>;
  /** package-relative file paths under packageDir (from `git ls-files`). */
  filePaths: string[];
}

export type DetectedDesignSystem = NonNullable<UxStackProfile['designSystem']>;

const THIRD_PARTY_UI_LIBS: Array<{ match: (deps: string[]) => boolean; name: string }> = [
  { match: (deps) => deps.some((d) => d.startsWith('@radix-ui/')), name: 'Radix' },
  { match: (deps) => deps.includes('@mui/material'), name: 'MUI' },
  { match: (deps) => deps.includes('@chakra-ui/react'), name: 'Chakra UI' },
  { match: (deps) => deps.includes('antd'), name: 'Ant Design' },
  { match: (deps) => deps.includes('@mantine/core'), name: 'Mantine' },
  { match: (deps) => deps.includes('react-bootstrap'), name: 'React Bootstrap' },
];

const IMPORT_ROOT_CANDIDATES = [
  'src/design/index.tsx',
  'src/design/index.ts',
  'src/components/ui/index.ts',
  'src/components/index.ts',
  'src/ui/index.ts',
];

const DESIGN_DIR_CANDIDATES = ['src/design', 'src/components/ui', 'src/components', 'src/ui'];

const TOKEN_SOURCE_CANDIDATES = [
  'src/styles/tokens.css',
  'src/styles/theme.css',
  'src/app/globals.css',
  'src/styles/globals.css',
  'tailwind.config.ts',
  'tailwind.config.js',
  'tailwind.config.mjs',
  'tailwind.config.cjs',
];

const TOAST_DEP_CANDIDATES = [
  'sonner',
  'react-hot-toast',
  'react-toastify',
  '@radix-ui/react-toast',
];

const I18N_DEPS = [
  'next-intl',
  'react-i18next',
  'i18next',
  'react-intl',
  '@lingui/core',
  'vue-i18n',
];

// Fixed emission order — determinism matters for the drift diff.
const STATE_PRIMITIVE_VOCAB = ['Skeleton', 'Spinner', 'EmptyState', 'ErrorState', 'Toast'] as const;

function kebabOf(pascalName: string): string {
  return pascalName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function detectLibraryName(deps: string[], filePaths: string[]): string | null {
  for (const lib of THIRD_PARTY_UI_LIBS) {
    if (lib.match(deps)) return lib.name;
  }
  if (filePaths.some((p) => basename(p) === 'components.json')) return 'shadcn/ui';
  return null;
}

function detectImportRoot(filePaths: string[]): string | null {
  const files = new Set(filePaths);
  return IMPORT_ROOT_CANDIDATES.find((c) => files.has(c)) ?? null;
}

function detectDesignDir(importRoot: string | null, filePaths: string[]): string | null {
  if (importRoot) return dirname(importRoot);
  return DESIGN_DIR_CANDIDATES.find((c) => filePaths.some((p) => p.startsWith(`${c}/`))) ?? null;
}

function detectTokenSource(filePaths: string[]): string | null {
  const files = new Set(filePaths);
  return TOKEN_SOURCE_CANDIDATES.find((c) => files.has(c)) ?? null;
}

function detectToastMechanism(deps: string[], filePaths: string[]): string | null {
  const hasLocalToast = filePaths.some(
    (p) => /(^|\/)primitives\/toast\.tsx$/.test(p) || /(^|\/)ui\/toast\.tsx$/.test(p),
  );
  if (hasLocalToast) return 'useToast()';
  return TOAST_DEP_CANDIDATES.find((d) => deps.includes(d)) ?? null;
}

function detectI18n(deps: string[], filePaths: string[]): boolean {
  if (I18N_DEPS.some((d) => deps.includes(d))) return true;
  return filePaths.some((p) => /(^|\/)(messages|locales)\//.test(p));
}

function detectBreakpoints(deps: string[]): string | null {
  if (deps.includes('tailwindcss') || deps.includes('@tailwindcss/postcss')) {
    return 'Tailwind sm/md/lg/xl';
  }
  return null;
}

function detectStatePrimitives(designDir: string | null, filePaths: string[]): string[] {
  if (!designDir) return [];
  const prefix = `${designDir}/`;
  // kebabOf() also normalizes an already-kebab-case stem (no-op, since it only
  // inserts a hyphen at a lower→upper boundary), so this matches both
  // `EmptyState.tsx` and `empty-state.tsx` against the same vocab entry.
  const stems = new Set(
    filePaths
      .filter((p) => p.startsWith(prefix))
      .map((p) => kebabOf(basename(p).replace(/\.(tsx|ts|jsx|js)$/, ''))),
  );
  return STATE_PRIMITIVE_VOCAB.filter((name) => stems.has(kebabOf(name)));
}

/**
 * Detect the §1 design-system facts from a repo snapshot. Total — never
 * throws; an empty/garbage snapshot returns all-null/false/empty.
 */
export function detectDesignSystem(snapshot: UxScanSnapshot): DetectedDesignSystem {
  const deps = Object.keys(snapshot.dependencies ?? {});
  const filePaths = snapshot.filePaths ?? [];

  const libraryName = detectLibraryName(deps, filePaths);
  const importRoot = detectImportRoot(filePaths);
  const designDir = detectDesignDir(importRoot, filePaths);
  const ownLibrary = libraryName === null && importRoot !== null;

  return {
    ownLibrary,
    libraryName,
    importRoot,
    tokenSource: detectTokenSource(filePaths),
    toastMechanism: detectToastMechanism(deps, filePaths),
    i18n: detectI18n(deps, filePaths),
    breakpoints: detectBreakpoints(deps),
    statePrimitives: detectStatePrimitives(designDir, filePaths),
  };
}

export interface DesignSystemRuleText {
  orderIndex: number;
  /** mirrors the CATALOG severities for ds-no-3rd-party/ds-compose/ds-tokens (must) and ds-new-primitive (should). */
  severity: 'must' | 'should';
  text: string;
}

/**
 * Derive the four §1 catalog rule texts (orderIndex 0..3) from a detection
 * result — real rule text a scan can persist, not just profile fields.
 */
// cm:edge contract -> packages/core/src/projects/ux-contract-presets.ts — orderIndex 0..3 must stay aligned with the designSystem CATALOG entries; the drift diff matches rules by (group, orderIndex)
export function designSystemRuleTexts(d: DetectedDesignSystem): DesignSystemRuleText[] {
  const noThirdParty = d.ownLibrary
    ? "Reuse the project's own design system — don't add a 3rd-party UI library or raw hex colors."
    : `This project is built on ${d.libraryName ?? 'a third-party UI library'} — don't introduce a second component library or raw hex colors.`;

  const compose = d.importRoot
    ? `Compose screens from the project's shared UI primitives and patterns; import them from \`${d.importRoot}\`.`
    : 'Compose screens from the project’s shared UI primitives and patterns; import them from the design-system entrypoint.';

  const tokens = d.tokenSource
    ? `Style only with the project's design tokens defined in \`${d.tokenSource}\` (color / spacing / radius / motion). No magic px, no hardcoded colors.`
    : 'Style only with the project’s design tokens (color / spacing / radius / motion). No magic px, no hardcoded colors.';

  const newPrimitive =
    d.statePrimitives && d.statePrimitives.length > 0
      ? `Need a new primitive? Add it alongside the existing ${d.statePrimitives.join('/')} primitives (tokens + a11y baked in); don't inline a one-off.`
      : "Need a new primitive? Add it to the design system (tokens + a11y baked in); don't inline a one-off.";

  return [
    { orderIndex: 0, severity: 'must', text: noThirdParty },
    { orderIndex: 1, severity: 'must', text: compose },
    { orderIndex: 2, severity: 'must', text: tokens },
    { orderIndex: 3, severity: 'should', text: newPrimitive },
  ];
}
