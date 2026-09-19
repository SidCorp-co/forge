import { sql } from 'drizzle-orm';

export const PIPELINE_METADATA_TYPES = sql`('pipeline','pm')`;

export const NON_CLIENT_METADATA_TYPES = sql`('pipeline','pm','master','run_session')`;

export const NEVER_PARKED_METADATA_TYPES = sql`('master')`;
