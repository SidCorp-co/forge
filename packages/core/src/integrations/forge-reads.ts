import type { ChangeRequestLinkKind, ChangeRequestReading } from '../db/schema-repo-projection.js';
import { portSlot } from '../lib/port-slot.js';

// What an adapter must know about Forge's own rows, handed in by the process entry at boot, so no
// adapter imports the module that owns them (ADR 0008: an adapter imports no domain or kernel).

interface ForgeReads {
  /** The repository the project document declares (`source.git.repository`), or null. */
  declaredRepository(projectId: string): Promise<string | null>;
  /** Every issue a change request delivers: the keys its branch, its title and its description name (REQ-63 BC-4). */
  issuesForChangeRequest(args: {
    projectId: string;
    headRef: string;
    title: string | null;
    description: string | null;
  }): Promise<Array<{ issueId: string; linkedBy: 'head-ref' | 'title' | 'description' }>>;
  /** Why a change request links no issue, naming what was read and the shapes that link (ISS-855). */
  noIssueForChangeRequest(args: {
    projectId: string;
    headRef: string;
    title: string | null;
    description: string | null;
  }): Promise<string>;
  /**
   * Each stored link of a change request with the reading that named it (ISS-1027): the branch's
   * leading key, the numbers its tail lists, its title or its body.
   */
  changeRequestLinkReadings(args: {
    headRef: string;
    links: ReadonlyArray<{ issueId: string; linkedBy: ChangeRequestLinkKind }>;
  }): Promise<
    Array<{ issueId: string; linkedBy: ChangeRequestLinkKind; namedBy: ChangeRequestReading }>
  >;
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
