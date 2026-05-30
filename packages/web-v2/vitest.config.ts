import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Minimal vitest config for web-v2 unit tests (pure feature logic — no DOM).
// The `@/` alias mirrors tsconfig `paths` so feature modules resolve the same
// way under test as under `next build`.
export default defineConfig({
  resolve: {
    alias: { '@': resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
