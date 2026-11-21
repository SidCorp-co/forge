import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { is } from 'drizzle-orm';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { UPLOAD_REFERENCE_COLUMNS } from './upload-references.js';

const DB = join(__dirname, '..', '..', 'db');
const schemaModules: Record<string, unknown>[] = await Promise.all(
  readdirSync(DB)
    .filter((f) => /^schema.*\.ts$/.test(f) && !f.endsWith('.test.ts'))
    .map((f) => import(join(DB, f)) as Promise<Record<string, unknown>>),
);

describe('the upload migration reads every column that stores an upload (ISS-1365)', () => {
  it('lists every path or storage_path column the schema declares, so no upload is dropped unread', () => {
    const declared = new Set<string>();
    for (const mod of schemaModules) {
      for (const value of Object.values(mod)) {
        if (value === null || typeof value !== 'object' || !is(value, PgTable)) continue;
        const config = getTableConfig(value);
        for (const col of config.columns) {
          if (col.name === 'path' || col.name === 'storage_path' || col.name === 'segments') {
            declared.add(`${config.name}.${col.name}`);
          }
        }
      }
    }
    expect([...declared].sort()).toEqual([...UPLOAD_REFERENCE_COLUMNS]);
  });
});
