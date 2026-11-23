// Who decides a project's releases, as its release read names them (REQ-90 BC-15, ISS-1432): the
// holders of releases.approve, and each speaker a project admin declared by chat identity for the
// release act, by the name the room shows, since their word decides it with no Forge account.

import type { ReleasePerson } from '@forge/contracts/releases';
import { onePerProject } from '../db/read-memo.js';
import { rulingDecidersOfProjects } from '../knowledge/index.js';
import { namedHolders } from '../permissions/index.js';

/**
 * The project's release deciders: holders first, then each declared speaker once. A declaration
 * scoped to named targets is read by the room that applies it, not here. The declarations of every
 * project read before the quiet point are one statement (ISS-1070 r6).
 */
export async function releaseDecidersOf(projectId: string): Promise<ReleasePerson[]> {
  const [holders, rulings] = await Promise.all([
    namedHolders('releases.approve', projectId),
    onePerProject('rulingDeciders', projectId, rulingDecidersOfProjects),
  ]);
  const declared = (rulings ?? [])
    .filter((d) => d.speaker && !d.targets && d.acts.includes('release'))
    .map((d) => ({
      id: `chat:${d.speaker?.externalId}`,
      name: `@${d.member}`,
      kind: 'human' as const,
    }));
  return [...holders, ...declared.filter((d, i) => declared.findIndex((x) => x.id === d.id) === i)];
}
