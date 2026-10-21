/**
 * What this Forge instance says about itself (REQ-47): one row at most, written only by an instance
 * admin. Nothing here is guessed — an instance with no row has said nothing, and a reader asking for a
 * setting it has not said gets null and refuses by name, never a default.
 */

import type {
  InstanceSettingsPatch,
  InstanceSettingsRefusalCode,
  InstanceSettingsView,
} from '@forge/contracts/instance-settings';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { instanceSettings } from '../db/schema-instance-settings.js';
import { projects } from '../db/schema-projects.js';
import { lockXact } from '../lib/advisory-lock.js';
import { peopleOf } from '../lib/people.js';
import { RefusalError } from '../lib/refusal.js';

const refuse = (code: InstanceSettingsRefusalCode, path: string, detail: string) =>
  new RefusalError([{ code, path, detail }], 'INSTANCE_SETTINGS_REFUSED');

async function settingsRow() {
  const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.id, 1)).limit(1);
  return row ?? null;
}

/** The project feedback about Forge is filed into, or null where the instance has named none. */
export async function forgeHomeProject(): Promise<{
  id: string;
  slug: string;
  name: string;
} | null> {
  const [row] = await db
    .select({ id: projects.id, slug: projects.slug, name: projects.name })
    .from(instanceSettings)
    .innerJoin(projects, eq(projects.id, instanceSettings.forgeHomeProjectId))
    .where(eq(instanceSettings.id, 1))
    .limit(1);
  return row ?? null;
}

export async function readInstanceSettings(): Promise<InstanceSettingsView> {
  const row = await settingsRow();
  const [home, people] = await Promise.all([
    forgeHomeProject(),
    peopleOf([row?.updatedBy ?? null]),
  ]);
  return {
    revision: row?.revision ?? 0,
    settings: { forgeHomeProject: home },
    updatedAt: row?.updatedAt.toISOString() ?? null,
    updatedBy: row?.updatedBy
      ? { id: row.updatedBy, name: people.get(row.updatedBy)?.name ?? null }
      : null,
  };
}

/**
 * Writes the keys `patch` names against `baseRevision`, the revision they were read at. A revision
 * that has moved since is refused naming both, and a project id naming no project is refused by name.
 */
export async function writeInstanceSettings(
  input: InstanceSettingsPatch,
  by: string,
): Promise<InstanceSettingsView> {
  const { patch } = input;
  if (patch.forgeHomeProjectId) {
    const [known] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(eq(projects.id, patch.forgeHomeProjectId))
      .limit(1);
    if (!known) {
      throw refuse(
        'INSTANCE_SETTINGS_PROJECT_UNKNOWN',
        '/patch/forgeHomeProjectId',
        `no project has id ${patch.forgeHomeProjectId}; name an existing project's id (GET /api/admin/projects lists them), or null for none`,
      );
    }
  }
  await db.transaction(async (tx) => {
    await lockXact(tx, 'instanceSettings', 'instance');
    const [row] = await tx
      .select({ revision: instanceSettings.revision })
      .from(instanceSettings)
      .where(eq(instanceSettings.id, 1));
    const current = row?.revision ?? 0;
    if (current !== input.baseRevision) {
      throw refuse(
        'INSTANCE_SETTINGS_STALE',
        '/baseRevision',
        `the settings are at revision ${current} and this write was made against ${input.baseRevision}; read them again and send the change against ${current}`,
      );
    }
    const values = {
      ...(patch.forgeHomeProjectId !== undefined
        ? { forgeHomeProjectId: patch.forgeHomeProjectId }
        : {}),
      revision: current + 1,
      updatedBy: by,
      updatedAt: new Date(),
    };
    if (row) await tx.update(instanceSettings).set(values).where(eq(instanceSettings.id, 1));
    else await tx.insert(instanceSettings).values({ id: 1, ...values });
  });
  return readInstanceSettings();
}
