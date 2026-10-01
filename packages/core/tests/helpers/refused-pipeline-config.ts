/**
 * ISS-1368 — the stored `pipelineConfig` the schema refuses, shared by the e2e files that assert
 * what each reader and each door does with it.
 */

import { sql } from 'drizzle-orm';
import { expect } from 'vitest';
import type { TestDb } from './db.js';

export const BAD_PATH = ' packages/runner';
export const RUNTIMES = [{ name: 'runner', paths: [BAD_PATH], servedBy: 'project-runners' }];
export const REFUSED = {
  enabled: true,
  poolBacklog: { statuses: ['confirmed'] },
  releaseRuntimes: RUNTIMES,
};
export const PLACE = 'pipelineConfig.releaseRuntimes.0.paths.0';

/** What a reader threw, as text, so each case asserts what a person reading it is told. */
export async function refusalOf(read: () => Promise<unknown>): Promise<string> {
  const err = await read().then(
    () => null,
    (e: unknown) => e,
  );
  expect(err, 'the reader answered instead of refusing').not.toBeNull();
  return err instanceof Error ? err.message : String(err);
}

export function expectNamed(said: string, projectId: string): void {
  expect(said).toContain(projectId);
  expect(said).toContain(PLACE);
  expect(said).toContain('a release runtime path is a path relative to the repository root');
}

export async function storeConfig(db: TestDb, projectId: string, config: unknown): Promise<void> {
  await db.execute(sql`
    UPDATE projects
       SET agent_config = jsonb_build_object('pipelineConfig', ${JSON.stringify(config)}::jsonb)
     WHERE id = ${projectId}
  `);
}
