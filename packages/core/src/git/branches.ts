/**
 * ISS-138 (PR-D) — thin shell wrappers used by the decomposition helper to
 * create + push a shared integration branch on the project's git remote.
 *
 * Inputs flow through `execFile`'s arg array (never `exec` with a string) so
 * branch / remote-ref values cannot smuggle shell metacharacters. The branch
 * name regex is the same one the issue metadata schema uses (ISS-137).
 *
 * Kept free of DB / Drizzle imports — pure git-shell wrapper. The core
 * process assumes filesystem access to `project.repoPath`. For deployments
 * that move runners off the core host, ISS-139 (PR-E) introduces a
 * runner-mediated path.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pExecFile = promisify(execFile);

const BRANCH_NAME_RE = /^[a-zA-Z0-9._/-]{1,100}$/;

export class IntegrationBranchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'IntegrationBranchError';
    this.code = code;
  }
}

async function firstRemote(repoPath: string): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await pExecFile('git', ['remote'], { cwd: repoPath }));
  } catch (e) {
    throw new IntegrationBranchError('GIT_REMOTE_FAILED', String(e));
  }
  const first = stdout.split('\n').find((l) => l.trim().length > 0);
  if (!first) {
    throw new IntegrationBranchError('NO_REMOTE', `no remote configured in ${repoPath}`);
  }
  return first.trim();
}

export async function gitRemoteHasBranch(repoPath: string, branch: string): Promise<boolean> {
  if (!BRANCH_NAME_RE.test(branch)) {
    throw new IntegrationBranchError('BAD_BRANCH_NAME', branch);
  }
  const remote = await firstRemote(repoPath);
  let stdout: string;
  try {
    ({ stdout } = await pExecFile('git', ['ls-remote', '--heads', remote, branch], {
      cwd: repoPath,
    }));
  } catch (e) {
    throw new IntegrationBranchError('GIT_FETCH_FAILED', String(e));
  }
  return stdout.trim().length > 0;
}

export interface CreateIntegrationBranchInput {
  repoPath: string;
  remoteRef: string;
  newBranch: string;
}

export interface CreateIntegrationBranchResult {
  remote: string;
  branch: string;
}

// TODO(PR-E, ISS-139): route through a runner adapter so off-host deployments
// can create the branch on a runner with push credentials instead of relying
// on the core host's working copy.
export async function createIntegrationBranch(
  input: CreateIntegrationBranchInput,
): Promise<CreateIntegrationBranchResult> {
  if (!BRANCH_NAME_RE.test(input.newBranch)) {
    throw new IntegrationBranchError('BAD_BRANCH_NAME', input.newBranch);
  }
  if (!BRANCH_NAME_RE.test(input.remoteRef)) {
    throw new IntegrationBranchError('BAD_BRANCH_NAME', input.remoteRef);
  }
  const remote = await firstRemote(input.repoPath);
  try {
    await pExecFile('git', ['fetch', remote, input.remoteRef], { cwd: input.repoPath });
  } catch (e) {
    throw new IntegrationBranchError('GIT_FETCH_FAILED', String(e));
  }
  try {
    await pExecFile(
      'git',
      ['push', remote, `${remote}/${input.remoteRef}:refs/heads/${input.newBranch}`],
      { cwd: input.repoPath },
    );
  } catch (e) {
    throw new IntegrationBranchError('GIT_PUSH_FAILED', String(e));
  }
  return { remote, branch: input.newBranch };
}
