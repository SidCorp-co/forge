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
      'module-shape/global-fetch': [
        'error',
        {
          allow: [
            {
              file: 'packages/core/src/schedules/script/worker-entry.ts',
              why: "The sandboxed schedule script's ctx.http.fetch: user code in a worker calling a URL the user wrote, held to https: and a timeout by the sandbox, not Forge reaching a system. There is no port to put between a user's script and the URL that script names; the sandbox is the boundary.",
            },
            {
              file: 'packages/core/src/assistant/bench-assistant.ts',
              why: "The assistant bench is a command-line harness that drives Forge's own API as a client and hands the global fetch to that client; the host it calls is the Forge under test, never a third-party system.",
            },
          ],
        },
      ],
    },
  },
];
