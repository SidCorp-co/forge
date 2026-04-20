import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Singleton postgres connection pool used by Drizzle.
const queryClient = postgres(url);

// Drizzle client — export this wherever DB access is needed.
export const db = drizzle(queryClient, { schema });

export type Db = typeof db;
