import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/db/schema.ts',
    './src/db/schema-activity.ts',
    './src/db/schema-admin-thresholds.ts',
    './src/db/schema-journal.ts',
    './src/db/schema-questions.ts',
    './src/db/schema-session-inbox.ts',
    './src/db/schema-speaker-links.ts',
    './src/db/schema-memory-chunks.ts',
    './src/db/schema-memory-revisions.ts',
    './src/db/schema-unaudited-transitions.ts',
    './src/db/schema-run-ledger.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
