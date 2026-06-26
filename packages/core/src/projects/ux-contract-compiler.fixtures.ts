import type { UxContractRuleInput } from './ux-contract-compiler.js';
import {
  PRESET_DEFAULT_TOGGLES,
  WEB_V2_PROFILE,
  compilePresetToRules,
  scaffoldOf,
} from './ux-contract-presets.js';

// The web-v2 scaffold + seed rules are DERIVED from the canonical WEB_V2_PROFILE
// (ISS-578) so the rule texts live in exactly one place. GOLDEN_UX_CONTRACT below
// is the independent, hand-authored expected output that guards byte-equality.
export const WEB_V2_SCAFFOLD = scaffoldOf(WEB_V2_PROFILE);

export const UX_CONTRACT_SEED_RULES: UxContractRuleInput[] = compilePresetToRules(
  'app-strict',
  WEB_V2_PROFILE,
  PRESET_DEFAULT_TOGGLES['app-strict'],
);

// Golden output: the exact current hand-authored projectFacts['ux-contract'] value.
// compileUxContract(UX_CONTRACT_SEED_RULES, WEB_V2_SCAFFOLD) must produce this string byte-for-byte.
export const GOLDEN_UX_CONTRACT = [
  '# UX Completeness Contract — web-v2 (forge-dev)',
  '',
  `BINDING for any issue that adds/changes UI in \`packages/web-v2/\`. "UX done" = every item below is satisfied, not just the happy/full screen. A pretty screen missing a required state is NOT done — review must REQUEST CHANGES.`,
  '',
  '## 1. Design system (reuse, never reinvent)',
  '- web-v2 has its OWN design system — NOT shadcn/Radix/MUI. Do not add a 3rd-party UI lib or raw hex colors.',
  '- Compose from `src/design/primitives/*` (Button, Input, Skeleton, Spinner, EmptyState, ErrorState, Toast, Checkbox, Radio, Toggle, …) and `src/design/patterns/*` (SlideOver, KanbanBoard, CommandPalette, …). Import via `src/design/index.ts`.',
  '- Style only with tokens from `src/styles/tokens.css` (semantic layer: `--bg-*`, `--fg-*`, `--border-*`, `--accent*`, spacing `--sp-*` on 4px base, radii `--r-*`, shadows, motion `--dur-*`). Use Tailwind utilities mapped from those tokens (Tailwind v4, no config file). No magic px / no hardcoded colors.',
  `- New primitive needed? Add it under \`src/design/primitives/\` (tokens + a11y baked in), don't inline a one-off.`,
  '',
  "## 2. Required states (the part 'make-it-pretty' skips)",
  '- **loading** → `<Skeleton>` (match final layout) or `<Spinner>`; submit buttons use `loading={mutation.isPending}`.',
  '- **error** → `<ErrorState>` with a Retry action + `formatApiError(error)`. Never a dead end, never a blank screen.',
  '- **empty** → `<EmptyState>` (mascot + one calm line + the action that fixes it, e.g. a Create button).',
  '- **empty-search / filtered-empty** → DISTINCT from first-run empty ("No results for X", offer clear-filter). Required whenever the surface is searchable/filterable.',
  '- **partial / paginated** → loading-more + end-of-list handled.',
  '- **happy** → data render with hover/active/disabled substates on interactive elements.',
  "Also: long text truncates gracefully; many-items doesn't break layout; disabled controls show why.",
  '',
  '## 3. Flows & feedback (task, not screen)',
  "- Design the whole task across steps; don't lose context/scroll/selection on navigation.",
  `- EVERY mutation gives feedback via \`useToast()\` — \`tone:'success'\` on done, \`tone:'error'\` + \`formatApiError\` on fail. No silent success.`,
  '- Destructive/irreversible actions require an explicit confirm step before firing.',
  '- Optimistic UI where it helps perceived speed, but reconcile on error.',
  '',
  '## 4. Accessibility bar',
  '- Interactive elements: real semantic HTML (`<button>`,`<a>`,`<label>`) or correct `role` + `aria-*` (see Toggle `role=switch`, Spinner `role=status`).',
  '- Keyboard: custom clickables handle Enter/Space; logical tab order; never remove focus outline — keep the `focus-visible` ring.',
  `- Respect \`prefers-reduced-motion\` (globals.css already gates animations — don't bypass it).`,
  `- Contrast: use \`--fg-*\` on \`--bg-*\` token pairs (designed for contrast); don't invent low-contrast greys.`,
  '',
  '## 5. Microcopy & tone',
  '- Plain, direct, non-apologetic, present tense, ONE calm line. English (no i18n system — hardcode EN).',
  `- Good: "Couldn't load" / "No labels yet — create one to organize issues." Bad: "Oops! Something went wrong 😢".`,
  '- Tell the user the next action, not just the failure.',
  '',
  '## 6. Responsive',
  '- Must work at 375px wide up. Tailwind breakpoints sm/md/lg/xl. Use BottomTabBar pattern for mobile nav where applicable. Verify mobile before calling done.',
  '',
  "## Known gaps (don't 'fix' by reinventing — work within these)",
  "- No i18n → hardcode English, don't wire a translation lib.",
  "- Dark theme is RESERVED in tokens but not shipped → don't add dark-only styles.",
  '- No jsx-a11y linter (lint WIP) → verify a11y by hand against §4.',
  `- \`SlideOver\`/modals lack a focus trap & there's no skip-link → for a NEW modal, add focus trap + Esc-to-close yourself.`,
  '',
  '## Definition of UX-Done (review checklist)',
  '[ ] loading  [ ] empty (first-run)  [ ] empty-search (if searchable)  [ ] error + retry  [ ] success/error toast on every mutation  [ ] destructive confirm  [ ] keyboard + visible focus  [ ] works at 375px  [ ] DS primitives + tokens only (no raw hex / 3rd-party lib)  [ ] microcopy tone',
  'Missing any applicable box ⇒ not done.',
].join('\n');
