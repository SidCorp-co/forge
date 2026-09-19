import { configure, DEFAULT_SIZE_FAMILIES } from "eslint-plugin-code-quality";
import tseslint from "typescript-eslint";

const TEST_FILES = [
  "**/*.{test,spec}.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "**/test/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "**/tests/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
  "**/__tests__/**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}",
];

const TOKENLESS_FILES = ["packages/web-v2/src/app/global-error.tsx"];

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/coverage/**",
      "**/target/**",
      ".worktrees/**",
      ".claude/**",
      "packages/core/drizzle/**",
      // Vendored tooling, like .forge/archmap: upstream code this repo does not author.
      ".forge/**",
    ],
  },
  {
    files: ["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts"],
    languageOptions: { parser: tseslint.parser, parserOptions: { sourceType: "module" } },
  },
  ...configure({
    "no-historical-narration": "error",
    "comment-density": "error",
    "max-consecutive-comment-lines": "error",
    "no-pass-through-wrapper": "error",
    "no-raw-colors": "error",
    "no-arbitrary-sizes": "error",
    "no-raw-elements": "error",
    tokens: { tokenSource: "packages/web-v2/src/app/globals.css" },
    primitives: { source: "packages/web-v2/src/design/primitives" },
  }),
  {
    rules: { "max-lines": "off", "max-lines-per-function": "off" },
  },
  {
    // The three design rules read `globals.css` and `src/design/primitives`, both of
    // which exist only in web-v2. Everywhere else their remedy — "use a token", "use
    // a primitive" — names something the package does not have.
    files: ["**/*"],
    ignores: ["packages/web-v2/src/**"],
    rules: {
      "code-quality/no-raw-colors": "off",
      "code-quality/no-arbitrary-sizes": "off",
      "code-quality/no-raw-elements": "off",
    },
  },
  {
    files: ["packages/web-v2/src/**"],
    rules: {
      "code-quality/no-arbitrary-sizes": [
        "error",
        {
          tokenSource: "packages/web-v2/src/app/globals.css",
          everywhere: DEFAULT_SIZE_FAMILIES.filter((family) => family.name !== "height"),
          exemptFiles: TOKENLESS_FILES,
        },
      ],
      "code-quality/no-raw-colors": [
        "error",
        {
          tokenSource: "packages/web-v2/src/app/globals.css",
          exemptFiles: [
            ...TOKENLESS_FILES,
            // Artwork, not theme: both reconstruct a raster mark in SVG and their
            // palette is matched to the PNG behind it. A colour that followed the
            // theme would drift off the image it has to sit on.
            "packages/web-v2/src/design/patterns/forge-mascot.tsx",
            "packages/web-v2/src/design/patterns/mascot-loaders.tsx",
            // Drawn onto a canvas and encoded as an icon: no element exists to read
            // a custom property from.
            "packages/web-v2/src/lib/notifications/favicon.ts",
            // Generated from the source content; an edit here is overwritten on the
            // next generate.
            "**/*.generated.*",
          ],
          allow: [
            {
              value: "#1284",
              why: "\"Release agent opened PR #1284\" — an issue number the hex matcher reads as a colour.",
            },
            {
              file: "packages/web-v2/src/features/project-settings/components/labels-tab.tsx",
              value: "#6b7280",
              why: "The colour field's default datum: the user picks it and the server stores it, and <input type=\"color\"> cannot take a var().",
            },
          ],
        },
      ],
    },
  },
  {
    files: TEST_FILES,
    rules: {
      "code-quality/no-pass-through-wrapper": "off",
      "code-quality/no-raw-colors": "off",
    },
  },
];
