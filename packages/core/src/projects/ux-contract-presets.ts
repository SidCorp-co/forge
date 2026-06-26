import type { UxContractRuleInput, UxContractScaffold } from './ux-contract-compiler.js';

// ISS-578 — the "choose, not write" authoring layer. A PRESET + a project's
// STACK PROFILE + structured TOGGLES compile into ux_contract_rules, which the
// ISS-574 compiler turns into the prose the pipeline reads. Users pick from
// these instead of authoring a contract from a blank box.

export const UX_PRESETS = ['app-strict', 'marketing', 'internal-tool', 'custom'] as const;
export type UxPreset = (typeof UX_PRESETS)[number];

export type UxRuleGroup = 'designSystem' | 'states' | 'flows' | 'a11y' | 'microcopy' | 'responsive';

/** Structured knobs a user flips; each adjusts exactly which catalog rules emit. */
export interface UxToggleSettings {
  /** empty-search / filtered-empty state required (searchable surfaces). */
  emptySearchRequired: boolean;
  /** destructive actions require an explicit confirm step. */
  destructiveConfirm: boolean;
  /** accessibility bar: 'basic' = semantics + keyboard; 'AA' = + reduced-motion + contrast. */
  a11yLevel: 'basic' | 'AA';
  /** mobile responsive (375px) required. */
  mobileResponsive: boolean;
  /** optimistic UI expected where it helps perceived speed. */
  optimisticUI: boolean;
}

/**
 * Per-project design-system facts. ISS-576 (auto-detect) populates this by
 * scanning the repo; ISS-578 ships the type + a hand-written web-v2 fixture.
 * `ruleOverrides` swaps a catalog rule's generic text for the project's exact
 * vocabulary (primitive names, token file, toast hook). The scaffold fields
 * (projectLabel/bindingScope/knownGaps) feed the compiler at recompile time.
 * Stored at `agentConfig.uxContractProfile`.
 */
export interface UxStackProfile {
  projectLabel: string;
  bindingScope: string;
  knownGaps: string[];
  /** catalog rule id → project-specific replacement text. */
  ruleOverrides?: Record<string, string>;
  /** Structured detection result (optional; filled by ISS-576). */
  designSystem?: {
    ownLibrary?: boolean;
    libraryName?: string | null;
    importRoot?: string | null;
    tokenSource?: string | null;
    toastMechanism?: string | null;
    i18n?: boolean;
    breakpoints?: string | null;
    statePrimitives?: string[];
  };
}

/** A compiled rule — assignable to UxContractRuleInput, plus DB/provenance fields. */
export interface CompiledUxRule extends UxContractRuleInput {
  id: string;
  group: UxRuleGroup;
  severity: 'must' | 'should';
  source: 'preset' | 'manual';
  status: 'active';
}

interface CatalogRule {
  id: string;
  group: UxRuleGroup;
  severity: 'must' | 'should';
  /** per-group order index (mirrors the canonical contract ordering). */
  orderIndex: number;
  /** generic, project-agnostic text used when the stack profile has no override. */
  text: string;
}

// The shared rule catalog. Presets differ by their default toggles (which drop
// rules); the stack profile overrides each rule's text with project specifics.
const CATALOG: CatalogRule[] = [
  // § 1 Design system
  {
    id: 'ds-no-3rd-party',
    group: 'designSystem',
    severity: 'must',
    orderIndex: 0,
    text: "Reuse the project's own design system — don't add a 3rd-party UI library or raw hex colors.",
  },
  {
    id: 'ds-compose',
    group: 'designSystem',
    severity: 'must',
    orderIndex: 1,
    text: 'Compose screens from the project’s shared UI primitives and patterns; import them from the design-system entrypoint.',
  },
  {
    id: 'ds-tokens',
    group: 'designSystem',
    severity: 'must',
    orderIndex: 2,
    text: 'Style only with the project’s design tokens (color / spacing / radius / motion). No magic px, no hardcoded colors.',
  },
  {
    id: 'ds-new-primitive',
    group: 'designSystem',
    severity: 'should',
    orderIndex: 3,
    text: "Need a new primitive? Add it to the design system (tokens + a11y baked in); don't inline a one-off.",
  },
  // § 2 Required states
  {
    id: 'st-loading',
    group: 'states',
    severity: 'must',
    orderIndex: 0,
    text: 'loading → a skeleton (matching the final layout) or spinner; submit buttons show a pending state.',
  },
  {
    id: 'st-error',
    group: 'states',
    severity: 'must',
    orderIndex: 1,
    text: 'error → an error state with a retry action and a readable message. Never a dead end, never a blank screen.',
  },
  {
    id: 'st-empty',
    group: 'states',
    severity: 'must',
    orderIndex: 2,
    text: 'empty (first-run) → an empty state with one calm line and the action that fixes it.',
  },
  {
    id: 'st-empty-search',
    group: 'states',
    severity: 'must',
    orderIndex: 3,
    text: 'empty-search / filtered-empty → distinct from first-run empty ("No results", offer clear-filter). Required whenever the surface is searchable/filterable.',
  },
  {
    id: 'st-partial',
    group: 'states',
    severity: 'should',
    orderIndex: 4,
    text: 'partial / paginated → loading-more and end-of-list handled.',
  },
  {
    id: 'st-happy',
    group: 'states',
    severity: 'must',
    orderIndex: 5,
    text: 'happy → data render with hover/active/disabled substates on interactive elements.',
  },
  // § 3 Flows & feedback
  {
    id: 'fl-whole-task',
    group: 'flows',
    severity: 'must',
    orderIndex: 0,
    text: "Design the whole task across steps; don't lose context/scroll/selection on navigation.",
  },
  {
    id: 'fl-feedback',
    group: 'flows',
    severity: 'must',
    orderIndex: 1,
    text: 'Every mutation gives success/error feedback (toast or inline). No silent success.',
  },
  {
    id: 'fl-destructive-confirm',
    group: 'flows',
    severity: 'must',
    orderIndex: 2,
    text: 'Destructive/irreversible actions require an explicit confirm step before firing.',
  },
  {
    id: 'fl-optimistic',
    group: 'flows',
    severity: 'should',
    orderIndex: 3,
    text: 'Optimistic UI where it helps perceived speed, but reconcile on error.',
  },
  // § 4 Accessibility
  {
    id: 'a11y-semantic',
    group: 'a11y',
    severity: 'must',
    orderIndex: 0,
    text: 'Interactive elements use real semantic HTML or a correct role + aria-*.',
  },
  {
    id: 'a11y-keyboard',
    group: 'a11y',
    severity: 'must',
    orderIndex: 1,
    text: 'Keyboard: custom clickables handle Enter/Space; logical tab order; keep a visible focus ring.',
  },
  {
    id: 'a11y-reduced-motion',
    group: 'a11y',
    severity: 'should',
    orderIndex: 2,
    text: 'Respect prefers-reduced-motion; don’t bypass the global motion gate.',
  },
  {
    id: 'a11y-contrast',
    group: 'a11y',
    severity: 'should',
    orderIndex: 3,
    text: "Contrast: use the designed fg/bg token pairs; don't invent low-contrast greys.",
  },
  // § 5 Microcopy & tone
  {
    id: 'mc-tone',
    group: 'microcopy',
    severity: 'must',
    orderIndex: 0,
    text: 'Plain, direct, non-apologetic, present tense, one calm line.',
  },
  {
    id: 'mc-examples',
    group: 'microcopy',
    severity: 'should',
    orderIndex: 1,
    text: 'Good: "Couldn’t load" / "No items yet — create one to get started." Bad: "Oops! Something went wrong 😢".',
  },
  {
    id: 'mc-next-action',
    group: 'microcopy',
    severity: 'must',
    orderIndex: 2,
    text: 'Tell the user the next action, not just the failure.',
  },
  // § 6 Responsive
  {
    id: 'rs-375',
    group: 'responsive',
    severity: 'must',
    orderIndex: 0,
    text: 'Must work at 375px wide and up; verify mobile before calling it done.',
  },
];

// Which catalog rules a toggle removes when switched OFF (or to 'basic').
function droppedRuleIds(t: UxToggleSettings): Set<string> {
  const drop = new Set<string>();
  if (!t.emptySearchRequired) drop.add('st-empty-search');
  if (!t.destructiveConfirm) drop.add('fl-destructive-confirm');
  if (!t.optimisticUI) drop.add('fl-optimistic');
  if (!t.mobileResponsive) drop.add('rs-375');
  if (t.a11yLevel === 'basic') {
    drop.add('a11y-reduced-motion');
    drop.add('a11y-contrast');
  }
  return drop;
}

export const PRESET_DEFAULT_TOGGLES: Record<UxPreset, UxToggleSettings> = {
  // SaaS/dashboard — the strict bar: all states + full a11y + mobile.
  'app-strict': {
    emptySearchRequired: true,
    destructiveConfirm: true,
    a11yLevel: 'AA',
    mobileResponsive: true,
    optimisticUI: true,
  },
  // Landing/marketing — responsive matters, fewer data-states, lighter a11y.
  marketing: {
    emptySearchRequired: false,
    destructiveConfirm: true,
    a11yLevel: 'basic',
    mobileResponsive: true,
    optimisticUI: false,
  },
  // Internal tool — pragmatic: states yes, a11y/mobile relaxed.
  'internal-tool': {
    emptySearchRequired: true,
    destructiveConfirm: true,
    a11yLevel: 'basic',
    mobileResponsive: false,
    optimisticUI: false,
  },
  // Custom — starts from the strict bar; the user tweaks every toggle.
  custom: {
    emptySearchRequired: true,
    destructiveConfirm: true,
    a11yLevel: 'AA',
    mobileResponsive: true,
    optimisticUI: true,
  },
};

/** Extract just the compiler scaffold from a stack profile. */
export function scaffoldOf(profile: UxStackProfile): UxContractScaffold {
  return {
    projectLabel: profile.projectLabel,
    bindingScope: profile.bindingScope,
    knownGaps: profile.knownGaps,
  };
}

/**
 * Compile a preset + a project's stack profile + toggle settings into the
 * `ux_contract_rules` set. Toggles default to the preset's defaults. The
 * resulting rules feed `compileUxContract(rules, scaffoldOf(profile))`.
 */
export function compilePresetToRules(
  preset: UxPreset,
  profile?: UxStackProfile,
  toggles: UxToggleSettings = PRESET_DEFAULT_TOGGLES[preset],
): CompiledUxRule[] {
  const drop = droppedRuleIds(toggles);
  return CATALOG.filter((r) => !drop.has(r.id)).map((r) => ({
    id: r.id,
    group: r.group,
    severity: r.severity,
    source: 'preset',
    status: 'active',
    orderIndex: r.orderIndex,
    text: profile?.ruleOverrides?.[r.id] ?? r.text,
  }));
}

/**
 * forge-dev / web-v2 reference profile. Its `ruleOverrides` are the canonical
 * web-v2 rule texts (the only place they live); `compilePresetToRules('app-strict',
 * WEB_V2_PROFILE)` + `compileUxContract(..., scaffoldOf(WEB_V2_PROFILE))`
 * reproduces the hand-authored contract byte-for-byte (see compiler golden test).
 */
export const WEB_V2_PROFILE: UxStackProfile = {
  projectLabel: 'web-v2 (forge-dev)',
  bindingScope: 'packages/web-v2/',
  knownGaps: [
    "No i18n → hardcode English, don't wire a translation lib.",
    "Dark theme is RESERVED in tokens but not shipped → don't add dark-only styles.",
    'No jsx-a11y linter (lint WIP) → verify a11y by hand against §4.',
    "`SlideOver`/modals lack a focus trap & there's no skip-link → for a NEW modal, add focus trap + Esc-to-close yourself.",
  ],
  designSystem: {
    ownLibrary: true,
    libraryName: null,
    importRoot: 'src/design/index.ts',
    tokenSource: 'src/styles/tokens.css',
    toastMechanism: 'useToast()',
    i18n: false,
    breakpoints: 'Tailwind sm/md/lg/xl',
    statePrimitives: ['Skeleton', 'Spinner', 'EmptyState', 'ErrorState', 'Toast'],
  },
  ruleOverrides: {
    'ds-no-3rd-party':
      'web-v2 has its OWN design system — NOT shadcn/Radix/MUI. Do not add a 3rd-party UI lib or raw hex colors.',
    'ds-compose':
      'Compose from `src/design/primitives/*` (Button, Input, Skeleton, Spinner, EmptyState, ErrorState, Toast, Checkbox, Radio, Toggle, …) and `src/design/patterns/*` (SlideOver, KanbanBoard, CommandPalette, …). Import via `src/design/index.ts`.',
    'ds-tokens':
      'Style only with tokens from `src/styles/tokens.css` (semantic layer: `--bg-*`, `--fg-*`, `--border-*`, `--accent*`, spacing `--sp-*` on 4px base, radii `--r-*`, shadows, motion `--dur-*`). Use Tailwind utilities mapped from those tokens (Tailwind v4, no config file). No magic px / no hardcoded colors.',
    'ds-new-primitive':
      "New primitive needed? Add it under `src/design/primitives/` (tokens + a11y baked in), don't inline a one-off.",
    'st-loading':
      '**loading** → `<Skeleton>` (match final layout) or `<Spinner>`; submit buttons use `loading={mutation.isPending}`.',
    'st-error':
      '**error** → `<ErrorState>` with a Retry action + `formatApiError(error)`. Never a dead end, never a blank screen.',
    'st-empty':
      '**empty** → `<EmptyState>` (mascot + one calm line + the action that fixes it, e.g. a Create button).',
    'st-empty-search':
      '**empty-search / filtered-empty** → DISTINCT from first-run empty ("No results for X", offer clear-filter). Required whenever the surface is searchable/filterable.',
    'st-partial': '**partial / paginated** → loading-more + end-of-list handled.',
    'st-happy':
      '**happy** → data render with hover/active/disabled substates on interactive elements.',
    'fl-whole-task':
      "Design the whole task across steps; don't lose context/scroll/selection on navigation.",
    'fl-feedback':
      "EVERY mutation gives feedback via `useToast()` — `tone:'success'` on done, `tone:'error'` + `formatApiError` on fail. No silent success.",
    'fl-destructive-confirm':
      'Destructive/irreversible actions require an explicit confirm step before firing.',
    'fl-optimistic': 'Optimistic UI where it helps perceived speed, but reconcile on error.',
    'a11y-semantic':
      'Interactive elements: real semantic HTML (`<button>`,`<a>`,`<label>`) or correct `role` + `aria-*` (see Toggle `role=switch`, Spinner `role=status`).',
    'a11y-keyboard':
      'Keyboard: custom clickables handle Enter/Space; logical tab order; never remove focus outline — keep the `focus-visible` ring.',
    'a11y-reduced-motion':
      "Respect `prefers-reduced-motion` (globals.css already gates animations — don't bypass it).",
    'a11y-contrast':
      "Contrast: use `--fg-*` on `--bg-*` token pairs (designed for contrast); don't invent low-contrast greys.",
    'mc-tone':
      'Plain, direct, non-apologetic, present tense, ONE calm line. English (no i18n system — hardcode EN).',
    'mc-examples':
      'Good: "Couldn\'t load" / "No labels yet — create one to organize issues." Bad: "Oops! Something went wrong 😢".',
    'mc-next-action': 'Tell the user the next action, not just the failure.',
    'rs-375':
      'Must work at 375px wide up. Tailwind breakpoints sm/md/lg/xl. Use BottomTabBar pattern for mobile nav where applicable. Verify mobile before calling done.',
  },
};
