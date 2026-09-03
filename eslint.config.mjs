// Only `comment-density` is on — biome owns the size limits, codemap owns comment content.
// The plugin's rules ship no `files` key and ESLint defaults to .js, so the TS entry below is what makes any .ts file lint at all.

import tsParser from "@typescript-eslint/parser";
import { configure } from "eslint-plugin-code-quality";

export default [
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
  },
  ...configure({
    "comment-density": "error",
    "no-historical-narration": "off",
    "no-duplicate-comment": "off",
    "max-consecutive-comment-lines": "off",
    "no-pass-through-wrapper": "off",
    "no-raw-colors": "off",
    "no-arbitrary-sizes": "off",
    "no-raw-elements": "off",
    "max-lines": "off",
    "max-lines-per-function": "off",
  }),
];
