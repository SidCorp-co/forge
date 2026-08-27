import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/db/schema.ts', './src/db/schema-journal.ts'],
  out: './drizzle/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
});
