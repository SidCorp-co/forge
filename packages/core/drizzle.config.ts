import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: [
    './src/db/schema.ts',
    './src/db/schema-activity.ts',
    './src/db/schema-journal.ts',
    './src/db/schema-session-inbox.ts',
  ],
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
