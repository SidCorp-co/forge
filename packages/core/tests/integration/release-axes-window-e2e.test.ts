/**
 * ISS-1046 — the two rows `0253_declared_release_axes.sql` FORCES rather than refuses.
 *
 * The fleet is written to while the migration is prepared: two google bindings appeared four
 * minutes apart between one measurement and the next on 2026-09-16. A transcription is therefore
 * never complete at boot, and the strict rule alone would make an unattended deploy a race it can
 * lose — a lost race aborts the container's boot, not merely the deploy.
 *
 * So two rows carry a forced value instead: a binding whose provider has no deploy adapter, where
 * `service` is the only role the server would accept, and a project created after the measurement
 * that carries no deploy-capable binding, where `none` is what the column's own DEFAULT gives every
 * project created a minute later. Neither is a judgement. Everything else still aborts by name, and
 * the cases here are what stops those two widening into the guess this whole change removes.
 *
 * The refusals themselves are in `release-axes-migration-e2e.test.ts`.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anyProject,
  BEFORE_THE_WINDOW,
  declaredFleet,
  type PreMigrationGround,
  plantBinding,
  plantProject,
  preMigrationGround,
  runForward,
} from './release-axes-migration-ground.js';

let groundDb: PreMigrationGround;

beforeAll(async () => {
  groundDb = await preMigrationGround();
}, 300_000);

afterAll(async () => {
  if (groundDb) await groundDb.stop();
});

const fleet = () => declaredFleet(groundDb);

describe('0253 forward — the two rows that carry no judgement', () => {
  // cm:why these exist because the fleet is WRITTEN TO while the migration is prepared: two google
  // bindings appeared four minutes apart between one measurement and the next on 2026-09-16. A
  // transcription is never complete at boot, so the strict rule alone makes an unattended deploy a
  // race it can lose — and a lost race aborts the container's boot rather than the deploy alone.

  // cm:guard `service` here is FORCED, not guessed. The server refuses `role: 'deploy'` on a
  // provider with no deploy adapter, so `service` is the only value this row may legally hold.
  // Widen this to a deploy-capable provider and the migration starts choosing between `{preview}`
  // and `{live}` for somebody — which is the judgement it exists to collect rather than make.
  it('gives a binding created after the measurement role=service where no other role is legal', async () => {
    const { db, g, projects } = await fleet();
    try {
      const strayId = randomUUID();
      await plantBinding(db.sql, g, {
        id: strayId,
        projectId: anyProject(projects).id,
        provider: 'google',
        environment: 'prod',
        label: 'wired-while-the-migration-waited',
      });

      await runForward(db.sql);

      const [row] = await db.sql.unsafe(
        `SELECT role, stages FROM integration_bindings WHERE id = $1`,
        [strayId],
      );
      expect(row?.role).toBe('service');
      expect(row?.stages).toEqual([]);
    } finally {
      await db.drop();
    }
  });

  it('gives a project created inside the deploy window release_model=none where it has no deploy binding', async () => {
    const { db, g } = await fleet();
    try {
      const strayId = randomUUID();
      await plantProject(db.sql, g, { id: strayId, slug: 'made-while-the-migration-waited' });

      await runForward(db.sql);

      const [row] = await db.sql.unsafe(
        `SELECT release_model, release_strategy FROM projects WHERE id = $1`,
        [strayId],
      );
      expect(row?.release_model).toBe('none');
      expect(row?.release_strategy).toBeNull();
    } finally {
      await db.drop();
    }
  });

  // cm:guard the window is not a blanket exemption. A project created in it that DOES carry a
  // deploy-capable binding could be a project somebody is releasing, and its model is a judgement
  // nobody made — so it still aborts by name.
  it('still aborts on a project created inside the window that carries a deploy-capable binding', async () => {
    const { db, g } = await fleet();
    try {
      const strayId = randomUUID();
      await plantProject(db.sql, g, { id: strayId, slug: 'new-and-deploying' });
      await plantBinding(db.sql, g, {
        projectId: strayId,
        provider: 'coolify',
        environment: 'staging',
      });

      await expect(runForward(db.sql)).rejects.toThrow(
        new RegExp(`${strayId}.*new-and-deploying`, 's'),
      );
    } finally {
      await db.drop();
    }
  });

  // cm:guard and a project OLDER than the window is declared by name or it aborts, whatever
  // bindings it has: every project that existed when a person read the fleet is in the list.
  it('still aborts on an undeclared project older than the window with no bindings at all', async () => {
    const { db, g } = await fleet();
    try {
      const strayId = randomUUID();
      await plantProject(db.sql, g, {
        id: strayId,
        slug: 'older-than-the-window',
        createdAt: BEFORE_THE_WINDOW,
      });

      await expect(runForward(db.sql)).rejects.toThrow(new RegExp(strayId));
    } finally {
      await db.drop();
    }
  });
});
