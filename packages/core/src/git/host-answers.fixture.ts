/** What git hosts write to stderr refusing a read over SSH, word for word, before the trailer git
 *  itself adds (`GIT_TRAILER`); the fake ssh in `tests/helpers/git-host-fixture.ts` plants them. */

export const GIT_TRAILER =
  'fatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n';

export const GITLAB_NO_ACCESS_SENTENCE =
  "The project you were looking for could not be found or you don't have permission to view it.";

export interface HostAnswer {
  name: string;
  stderr: string;
  exit: number;
  /** The words of it a refusal must carry. */
  said: string;
}

/** A key GitLab knows, asked for a project it may not read, or one that does not exist. */
export const GITLAB_NO_ACCESS: HostAnswer = {
  name: 'GitLab, a known key with no access to the project',
  stderr: [
    'remote: ',
    'remote: ========================================================================',
    'remote: ',
    `remote: ERROR: ${GITLAB_NO_ACCESS_SENTENCE}`,
    '',
    'remote: ',
    'remote: ========================================================================',
    'remote: ',
    '',
  ].join('\n'),
  exit: 1,
  said: `ERROR: ${GITLAB_NO_ACCESS_SENTENCE}`,
};

/** A key GitHub knows, asked for a repository it may not read, or one that does not exist. */
export const GITHUB_NOT_FOUND: HostAnswer = {
  name: 'GitHub over SSH, a known key with no access to the repository',
  stderr: 'ERROR: Repository not found.\n',
  exit: 1,
  said: 'ERROR: Repository not found.',
};

/** Any host that was never given the key: ssh's own refusal, with its carriage return. */
export function keyUnknown(host: string): HostAnswer {
  return {
    name: `${host}, a key it does not know`,
    stderr: `git@${host}: Permission denied (publickey).\r\n`,
    exit: 255,
    said: `git@${host}: Permission denied (publickey).`,
  };
}

/** A plain git server over SSH, asked for a path that holds no repository. */
export const NO_REPOSITORY: HostAnswer = {
  name: 'a plain git server, no repository at the path',
  stderr: "fatal: '/srv/git/sid/desk.git' does not appear to be a git repository\n",
  exit: 128,
  said: "'/srv/git/sid/desk.git' does not appear to be a git repository",
};

/** ssh failing to connect to the address the host guard pinned. */
export function unreachable(address: string): HostAnswer {
  return {
    name: 'a host that cannot be reached',
    stderr: `ssh: connect to host ${address} port 22: Connection timed out\r\n`,
    exit: 255,
    said: 'port 22: Connection timed out',
  };
}
