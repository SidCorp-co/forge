// The module-shape lint: run by scripts/check-module-shape.mjs, never by the root eslint.config.mjs.
// The bulk-suppressions file is its only amnesty, so inline disable comments are not read.

import tseslint from 'typescript-eslint';
import { ROOT } from './declaration.mjs';
import moduleShape from './plugin.mjs';

export default [
  {
    basePath: ROOT,
    files: ['packages/core/src/**/*.ts'],
    ignores: [
      '**/*.test.ts',
      '**/*.spec.ts',
      '**/*.d.ts',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/test-helpers/**',
      '**/test-helper*.ts',
    ],
    linterOptions: { noInlineConfig: true, reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: ROOT },
    },
    plugins: { 'module-shape': moduleShape },
    rules: {
      'module-shape/table-writer': 'error',
      'module-shape/route-query': 'error',
      'module-shape/refusal': 'error',
      'module-shape/global-fetch': 'error',
    },
  },
];
