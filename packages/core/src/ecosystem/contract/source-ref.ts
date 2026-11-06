// A contract version's `sourceRef` (`<repository path>@<commit>`) is held to what the source host
// holds (ISS-981, catalog-api FB-501): site-sync-events-v1 2.0.0 was recorded from 0531e1dd, a
// commit that never landed, not from the landed artifact at a2c403e4, and the door took it. The
// commit must be on the project's base branch, and an artifact that is a file must be the file at
// that path and commit, byte for byte. The host is the project's ancestry source
// (`release-batch/ancestry-source.ts`); where it cannot be read, the refusal says so and nothing is
// guessed.

import { readDeclaredSource } from '../../project-config/index.js';
import { type AncestrySource, ancestrySourceFor } from '../../release-batch/index.js';
import type { EcosystemRefusal } from '../refusals.js';
import { MAX_ARTIFACT_BYTES, sha256 } from './measure.js';

const short = (digest: string) => digest.slice(0, 12);

/**
 * The kinds whose artifact is a file in the repository as it stands. A `cli` or `mcp-tools` artifact
 * is the `{ program, commands }` or `{ tools }` JSON described from the source its `sourceRef` names,
 * which no file holds byte for byte, so only its commit is held to the base branch.
 */
const READ_AS_A_FILE: ReadonlySet<string> = new Set(['graphql', 'openapi', 'json-schema']);

const unread = (sourceRef: string, why: string): EcosystemRefusal => ({
  code: 'CONTRACT_SOURCE_UNREAD',
  path: '/sourceRef',
  detail: `${sourceRef} cannot be checked against the source host: ${why}. A version is recorded from the artifact's file at a commit on the project's base branch, read from the host; nothing was recorded, and nothing is taken on trust in its place.`,
});

async function hostOf(projectId: string): Promise<AncestrySource | { kind: 'error'; why: string }> {
  try {
    return await ancestrySourceFor(projectId);
  } catch (err) {
    return { kind: 'error', why: err instanceof Error ? err.message : String(err) };
  }
}

/** Why `sourceRef`, and the artifact uploaded beside it, may not be recorded; empty where both hold. */
export async function sourceRefRefusals(
  projectId: string,
  sourceRef: string,
  artifact: string | undefined,
  /** The publication's contract type, which says whether the artifact is the file itself. */
  kind: string,
): Promise<EcosystemRefusal[]> {
  const at = sourceRef.lastIndexOf('@');
  const path = sourceRef.slice(0, at);
  const commit = sourceRef.slice(at + 1);
  const { defaultBranch } = await readDeclaredSource(projectId);
  if (!defaultBranch) {
    return [
      unread(
        sourceRef,
        'the project document names no base branch (`source.git.defaultBranch`), so whether the commit landed has no branch to be read on',
      ),
    ];
  }
  const source = await hostOf(projectId);
  if (source.kind !== 'host') {
    return [unread(sourceRef, `the project has no source host to read it from (${source.why})`)];
  }
  try {
    if (!(await source.host.branchContains(defaultBranch, commit))) {
      return [
        {
          code: 'CONTRACT_SOURCE_NOT_LANDED',
          path: '/sourceRef',
          detail: `${commit} is not on \`${defaultBranch}\`, the project's base branch, so ${sourceRef} names a revision that never landed. Record the version from the artifact's file at a commit on \`${defaultBranch}\`: \`${path}@<that commit>\`.`,
        },
      ];
    }
    if (artifact === undefined || !READ_AS_A_FILE.has(kind)) return [];
    const file = await source.host.readFile(path, commit, MAX_ARTIFACT_BYTES);
    if (typeof file !== 'string') {
      return [
        {
          code: 'CONTRACT_SOURCE_FILE_MISSING',
          path: '/sourceRef',
          detail: `the source host holds no file at ${sourceRef} (${file.missing}). \`sourceRef\` names the artifact's own file and the commit it was read at, \`<repository path>@<commit>\`, such as \`schema.graphql@1a2b3c4\`.`,
        },
      ];
    }
    const sent = sha256(artifact);
    const held = sha256(file);
    if (sent !== held) {
      return [
        {
          code: 'CONTRACT_SOURCE_DIGEST_MISMATCH',
          path: '/artifact',
          detail: `the artifact uploaded (sha256 ${short(sent)}) is not the file at ${sourceRef} (sha256 ${short(held)}): a version is recorded from the file as it stands at the commit it names. Upload that file's text, or name the commit whose file this is.`,
        },
      ];
    }
    return [];
  } catch (err) {
    return [
      unread(
        sourceRef,
        `the source host could not be read (${err instanceof Error ? err.message : String(err)})`,
      ),
    ];
  }
}
