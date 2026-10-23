import { portSlot } from '../lib/port-slot.js';

// What an adapter must know about Forge's own rows, handed in by the process entry at boot, so no
// adapter imports the module that owns them (ADR 0008: an adapter imports no domain or kernel).

interface ForgeReads {
  /** The repository the project document declares (`source.git.repository`), or null. */
  declaredRepository(projectId: string): Promise<string | null>;
  /** Every issue a change request delivers: the keys its branch and its description name (REQ-63 BC-4). */
  issuesForChangeRequest(args: {
    projectId: string;
    headRef: string;
    description: string | null;
  }): Promise<Array<{ issueId: string; linkedBy: 'head-ref' | 'description' }>>;
  /** A project's slug, or null when no such project exists. */
  projectSlug(projectId: string): Promise<string | null>;
  /** Id, slug and name of each project in `ids` that exists. */
  projectsByIds(ids: readonly string[]): Promise<{ id: string; slug: string; name: string }[]>;
  /** The project a pipeline run belongs to, or null when no such run exists. */
  runProjectOf(runId: string): Promise<string | null>;
  /** Every project a device runs a runner for, whatever the runner's type. */
  deviceProjects(deviceId: string): Promise<string[]>;
}

const slot = portSlot<ForgeReads>('integrations', 'provideForgeReads');
export const provideForgeReads = slot.provide;
export const forgeReads = slot.get;
