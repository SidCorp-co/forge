// web-v2's lint (CODE-STANDARD.md is the rule book; this file is its enforcement).
// Today's violations are frozen in eslint-suppressions.json (ESLint bulk suppressions): a file
// may not gain a violation of a rule, and the file's frozen counts may only fall. The UI sweep
// drains it; at zero the suppressions file is deleted and every rule blocks outright.
// Inventory: `pnpm --filter web-v2 lint:inventory`.

import eslintReact from "@eslint-react/eslint-plugin";
import pluginQuery from "@tanstack/eslint-plugin-query";
import boundaries from "eslint-plugin-boundaries";
import jsxA11y from "eslint-plugin-jsx-a11y";
import reactHooks from "eslint-plugin-react-hooks";
import sonarjs from "eslint-plugin-sonarjs";
import globals from "globals";
import tseslint from "typescript-eslint";
import uiGrammar from "./eslint/ui-grammar.mjs";

const DESIGN_ONLY =
  "is a behaviour library web-v2 keeps behind its own design system (ISS-1172). Import it only inside src/design/**, and give features a component or hook from @/design.";
const SENTRY =
  "The browser's own error reporting leaves through the error-tracking port. Report with reportFailure, reportCondition or traceStep from @/lib/error-tracking; only the adapter, src/lib/sentry.ts, imports the SDK.";

/** Imports every file outside src/design may not make. */
const LIBRARY_BANS = {
  paths: ["react-hook-form", "@hookform/resolvers", "@tanstack/react-table", "@tanstack/react-virtual"].map((name) => ({
    name,
    message: `${name} ${DESIGN_ONLY}`,
  })),
  patterns: [
    { group: ["react-hook-form/**", "@hookform/resolvers/**", "@tanstack/react-table/**", "@tanstack/react-virtual/**"], message: `This package ${DESIGN_ONLY}` },
    { group: ["@sentry/**"], message: SENTRY },
  ],
};

/** A feature reaches primitives, icons and shadcn parts only through @/design. */
const FEATURE_IMPORT_BANS = {
  paths: [...LIBRARY_BANS.paths, { name: "lucide-react", message: "Icons come from <Icon name=… /> in @/design (16px, stroke 1.5)." }],
  patterns: [
    ...LIBRARY_BANS.patterns,
    { group: ["@base-ui/react", "@base-ui/react/**"], message: "Base UI parts reach features through @/design (CODE-STANDARD.md, Base UI and shadcn)." },
    { group: ["@/components/ui/*", "@/components/ui/**"], message: "shadcn parts are src/design's to wrap; import the @/design component instead." },
    { group: ["lucide-react/**"], message: "Icons come from <Icon name=… /> in @/design." },
  ],
};

// A class string or style value in a feature, matched as written (esquery regex: no `/` inside).
const HEX = String.raw`(^#[0-9a-fA-F]{3,4}$)|(#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?\b)|(\b(rgba?|hsla?|oklch|oklab)\()`;
const ARBITRARY = String.raw`(^|\s)[!a-z0-9:-]*-\[[^\]\s]+\]|(^|\s)\[[a-z-]+:[^\]\s]+\]`;
const SHADOW = String.raw`(^|[\s:])shadow(-(?!focus\b|focus-accent\b|none\b)[a-z0-9-]+)?($|\s)`;
const ROUNDED_LG = String.raw`(^|[\s:])rounded(-[trblse]{1,2})?-(lg|xl|2xl|3xl|4xl)($|\s)`;

const textMatches = (re, message) => [
  { selector: `Literal[value=/${re}/]`, message },
  { selector: `TemplateElement[value.raw=/${re}/]`, message },
];

const FEATURE_SYNTAX_BANS = [
  ...textMatches(HEX, "No colour literal in a feature: use a token class (bg-surface, text-danger-11) or var(--token)."),
  ...textMatches(ARBITRARY, "No Tailwind arbitrary value in a feature: use the scale (p-3, text-13, w-64) or a block from @/design."),
  ...textMatches(SHADOW, "No shadow on a feature surface: surfaces are flat; only overlays (from @/design) cast one."),
  ...textMatches(ROUNDED_LG, "No rounded-lg or larger: surfaces are radius 0, controls rounded-sm/rounded-md."),
  { selector: "JSXOpeningElement[name.name='table']", message: "No raw <table> in a feature: use Table from @/design (TanStack Table)." },
  { selector: "JSXOpeningElement[name.name='select']", message: "No raw <select> in a feature: use Select from @/design." },
];

/** A component or hook reads server state through a query, never fetch (api.ts and server/ modules are where fetch lives). */
const NO_FETCH = { selector: "CallExpression[callee.name='fetch']", message: "No fetch in a component or hook: read through the feature's api.ts and a TanStack Query queryOptions factory." };

const configs = tseslint.config(
  {
    ignores: ["dist/**", "coverage/**", "node_modules/**", "public/**", "src/routeTree.gen.ts", "src/components/ui/**", "witness/**", "scripts/**", "eslint/**", "*.config.*"],
  },
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      // tsconfig.json is the source alone (the default typecheck); the test config is source + tests
      parserOptions: { project: "./tsconfig.test.json", tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.browser, ...globals.node },
    },
  },
  reactHooks.configs.flat["recommended-latest"],
  eslintReact.configs["recommended-type-checked"],
  // react-hooks owns the hooks and compiler rules; @eslint-react keeps the rest
  eslintReact.configs["disable-conflict-eslint-plugin-react-hooks"],
  ...pluginQuery.configs["flat/recommended"],
  jsxA11y.flatConfigs.recommended,
  {
    plugins: { sonarjs, boundaries, "ui-grammar": uiGrammar },
    settings: {
      "import/resolver": { typescript: { project: "./tsconfig.json" } },
      "boundaries/elements": [
        { type: "app", pattern: "src/app" },
        { type: "design", pattern: "src/design" },
        { type: "ui", pattern: "src/components/ui" },
        { type: "feature", pattern: "src/features/*", capture: ["domain"] },
        { type: "lib", pattern: "src/lib" },
        { type: "providers", pattern: "src/providers" },
      ],
    },
    rules: {
      // the length axis, as biome held it: a file over 500 lines, a function over 150
      "max-lines": ["error", { max: 500 }],
      "max-lines-per-function": ["error", { max: 150, skipBlankLines: true, IIFEs: false }],
      "sonarjs/cognitive-complexity": ["error", 25],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // `const { omitted: _x, ...rest } = obj` is how a key is dropped; an underscore marks it read on purpose
      "@typescript-eslint/no-unused-vars": ["error", { ignoreRestSiblings: true, varsIgnorePattern: "^_", argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "no-restricted-imports": ["error", LIBRARY_BANS],
      "boundaries/dependencies": [
        "error",
        {
          default: "allow",
          policies: [
            {
              from: { element: { type: "feature" } },
              disallow: { to: { element: { type: "feature" } } },
              message: "A feature imports another feature only through its index.ts (CODE-STANDARD.md, Structure).",
            },
            { from: { element: { type: "feature" } }, allow: { to: { element: { type: "feature", fileInternalPath: "index.{ts,tsx}" } } } },
            {
              from: { element: { types: { anyOf: ["design", "lib", "ui"] } } },
              disallow: { to: { element: { types: { anyOf: ["feature", "app", "providers"] } } } },
              message: "src/design, src/lib and src/components/ui never import a feature, a route or a provider.",
            },
            {
              from: { element: { types: { anyOf: ["feature", "app", "lib", "providers"] } } },
              disallow: { to: { element: { type: "ui" } } },
              message: "src/components/ui is wrapped by src/design; import the @/design component.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["src/features/**/*.{ts,tsx}"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", FEATURE_IMPORT_BANS],
      "no-restricted-syntax": ["error", ...FEATURE_SYNTAX_BANS],
      "ui-grammar/no-layout-name": "error",
    },
  },
  {
    files: ["src/features/**/components/**/*.{ts,tsx}", "src/features/**/hooks.ts", "src/features/**/hooks/**/*.ts"],
    ignores: ["**/*.test.{ts,tsx}"],
    rules: { "no-restricted-syntax": ["error", ...FEATURE_SYNTAX_BANS, NO_FETCH] },
  },
  { files: ["src/design/**"], rules: { "no-restricted-imports": "off" } },
  { files: ["src/lib/sentry.ts"], rules: { "no-restricted-imports": "off" } },
);

/** A warning is read by nobody (scripts/README.md, R9): every rule a preset sets to warn blocks. */
const blocking = (level) => (level === "warn" || level === 1 ? "error" : level);
export default configs.map((c) =>
  c.rules
    ? { ...c, rules: Object.fromEntries(Object.entries(c.rules).map(([k, v]) => [k, Array.isArray(v) ? [blocking(v[0]), ...v.slice(1)] : blocking(v)])) }
    : c,
);
