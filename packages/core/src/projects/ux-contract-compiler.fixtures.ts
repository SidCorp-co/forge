import type { UxContractRuleInput } from './ux-contract-compiler.js';

export const UX_CONTRACT_SEED_RULES: UxContractRuleInput[] = [
  // § 1 Design system
  {
    group: 'designSystem',
    text: 'web-v2 has its OWN design system — NOT shadcn/Radix/MUI. Do not add a 3rd-party UI lib or raw hex colors.',
    status: 'active',
    orderIndex: 0,
  },
  {
    group: 'designSystem',
    text: `Compose from \`src/design/primitives/*\` (Button, Input, Skeleton, Spinner, EmptyState, ErrorState, Toast, Checkbox, Radio, Toggle, …) and \`src/design/patterns/*\` (SlideOver, KanbanBoard, CommandPalette, …). Import via \`src/design/index.ts\`.`,
    status: 'active',
    orderIndex: 1,
  },
  {
    group: 'designSystem',
    text: `Style only with tokens from \`src/styles/tokens.css\` (semantic layer: \`--bg-*\`, \`--fg-*\`, \`--border-*\`, \`--accent*\`, spacing \`--sp-*\` on 4px base, radii \`--r-*\`, shadows, motion \`--dur-*\`). Use Tailwind utilities mapped from those tokens (Tailwind v4, no config file). No magic px / no hardcoded colors.`,
    status: 'active',
    orderIndex: 2,
  },
  {
    group: 'designSystem',
    text: `New primitive needed? Add it under \`src/design/primitives/\` (tokens + a11y baked in), don't inline a one-off.`,
    status: 'active',
    orderIndex: 3,
  },

  // § 2 Required states
  {
    group: 'states',
    text: `**loading** → \`<Skeleton>\` (match final layout) or \`<Spinner>\`; submit buttons use \`loading={mutation.isPending}\`.`,
    status: 'active',
    orderIndex: 0,
  },
  {
    group: 'states',
    text: `**error** → \`<ErrorState>\` with a Retry action + \`formatApiError(error)\`. Never a dead end, never a blank screen.`,
    status: 'active',
    orderIndex: 1,
  },
  {
    group: 'states',
    text: `**empty** → \`<EmptyState>\` (mascot + one calm line + the action that fixes it, e.g. a Create button).`,
    status: 'active',
    orderIndex: 2,
  },
  {
    group: 'states',
    text: '**empty-search / filtered-empty** → DISTINCT from first-run empty ("No results for X", offer clear-filter). Required whenever the surface is searchable/filterable.',
    status: 'active',
    orderIndex: 3,
  },
  {
    group: 'states',
    text: '**partial / paginated** → loading-more + end-of-list handled.',
    status: 'active',
    orderIndex: 4,
  },
  {
    group: 'states',
    text: '**happy** → data render with hover/active/disabled substates on interactive elements.',
    status: 'active',
    orderIndex: 5,
  },

  // § 3 Flows & feedback
  {
    group: 'flows',
    text: "Design the whole task across steps; don't lose context/scroll/selection on navigation.",
    status: 'active',
    orderIndex: 0,
  },
  {
    group: 'flows',
    text: `EVERY mutation gives feedback via \`useToast()\` — \`tone:'success'\` on done, \`tone:'error'\` + \`formatApiError\` on fail. No silent success.`,
    status: 'active',
    orderIndex: 1,
  },
  {
    group: 'flows',
    text: 'Destructive/irreversible actions require an explicit confirm step before firing.',
    status: 'active',
    orderIndex: 2,
  },
  {
    group: 'flows',
    text: 'Optimistic UI where it helps perceived speed, but reconcile on error.',
    status: 'active',
    orderIndex: 3,
  },

  // § 4 Accessibility
  {
    group: 'a11y',
    text: `Interactive elements: real semantic HTML (\`<button>\`,\`<a>\`,\`<label>\`) or correct \`role\` + \`aria-*\` (see Toggle \`role=switch\`, Spinner \`role=status\`).`,
    status: 'active',
    orderIndex: 0,
  },
  {
    group: 'a11y',
    text: `Keyboard: custom clickables handle Enter/Space; logical tab order; never remove focus outline — keep the \`focus-visible\` ring.`,
    status: 'active',
    orderIndex: 1,
  },
  {
    group: 'a11y',
    text: `Respect \`prefers-reduced-motion\` (globals.css already gates animations — don't bypass it).`,
    status: 'active',
    orderIndex: 2,
  },
  {
    group: 'a11y',
    text: `Contrast: use \`--fg-*\` on \`--bg-*\` token pairs (designed for contrast); don't invent low-contrast greys.`,
    status: 'active',
    orderIndex: 3,
  },

  // § 5 Microcopy & tone
  {
    group: 'microcopy',
    text: 'Plain, direct, non-apologetic, present tense, ONE calm line. English (no i18n system — hardcode EN).',
    status: 'active',
    orderIndex: 0,
  },
  {
    group: 'microcopy',
    text: `Good: "Couldn't load" / "No labels yet — create one to organize issues." Bad: "Oops! Something went wrong 😢".`,
    status: 'active',
    orderIndex: 1,
  },
  {
    group: 'microcopy',
    text: 'Tell the user the next action, not just the failure.',
    status: 'active',
    orderIndex: 2,
  },

  // § 6 Responsive
  {
    group: 'responsive',
    text: 'Must work at 375px wide up. Tailwind breakpoints sm/md/lg/xl. Use BottomTabBar pattern for mobile nav where applicable. Verify mobile before calling done.',
    status: 'active',
    orderIndex: 0,
  },
];

// Golden output: the exact current hand-authored projectFacts['ux-contract'] value.
// compileUxContract(UX_CONTRACT_SEED_RULES) must produce this string byte-for-byte.
export const GOLDEN_UX_CONTRACT = [
  '# UX Completeness Contract — web-v2 (forge-dev)',
  '',
  `BINDING for any issue that adds/changes UI in \`packages/web-v2/\`. "UX done" = every item below is satisfied, not just the happy/full screen. A pretty screen missing a required state is NOT done — review must REQUEST CHANGES.`,
  '',
  '## 1. Design system (reuse, never reinvent)',
  '- web-v2 has its OWN design system — NOT shadcn/Radix/MUI. Do not add a 3rd-party UI lib or raw hex colors.',
  `- Compose from \`src/design/primitives/*\` (Button, Input, Skeleton, Spinner, EmptyState, ErrorState, Toast, Checkbox, Radio, Toggle, …) and \`src/design/patterns/*\` (SlideOver, KanbanBoard, CommandPalette, …). Import via \`src/design/index.ts\`.`,
  `- Style only with tokens from \`src/styles/tokens.css\` (semantic layer: \`--bg-*\`, \`--fg-*\`, \`--border-*\`, \`--accent*\`, spacing \`--sp-*\` on 4px base, radii \`--r-*\`, shadows, motion \`--dur-*\`). Use Tailwind utilities mapped from those tokens (Tailwind v4, no config file). No magic px / no hardcoded colors.`,
  `- New primitive needed? Add it under \`src/design/primitives/\` (tokens + a11y baked in), don't inline a one-off.`,
  '',
  "## 2. Required states (the part 'make-it-pretty' skips)",
  `- **loading** → \`<Skeleton>\` (match final layout) or \`<Spinner>\`; submit buttons use \`loading={mutation.isPending}\`.`,
  `- **error** → \`<ErrorState>\` with a Retry action + \`formatApiError(error)\`. Never a dead end, never a blank screen.`,
  `- **empty** → \`<EmptyState>\` (mascot + one calm line + the action that fixes it, e.g. a Create button).`,
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
  `- Interactive elements: real semantic HTML (\`<button>\`,\`<a>\`,\`<label>\`) or correct \`role\` + \`aria-*\` (see Toggle \`role=switch\`, Spinner \`role=status\`).`,
  `- Keyboard: custom clickables handle Enter/Space; logical tab order; never remove focus outline — keep the \`focus-visible\` ring.`,
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
