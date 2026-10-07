import { describe, expect, it } from 'vitest';
import { fetchRefusal, hostRefusal, hostSaid } from './bounded-fetch.js';
import {
  GIT_TRAILER,
  GITHUB_NOT_FOUND,
  GITLAB_NO_ACCESS,
  type HostAnswer,
  keyUnknown,
  NO_REPOSITORY,
  unreachable,
} from './host-answers.fixture.js';

const REMOTE = 'git@gitlab.com:sid/desk.git';
const GIT_ACCESS = "the project's Settings → Runners → Git access";
/** What every sentence asks the key be given: Test connection's too (`ssh-keys.test.ts`). */
const ASK =
  "write access to that repository, since Forge reads the repository with it and the project's runner pushes with it";

const refusalOf = (a: HostAnswer) =>
  fetchRefusal({ stderr: a.stderr + GIT_TRAILER, code: 128 }, REMOTE);

describe('hostSaid', () => {
  it("names GitLab's sentence, not the bare remote: banner it opens with", () => {
    expect(hostSaid(GITLAB_NO_ACCESS.stderr + GIT_TRAILER)).toBe(GITLAB_NO_ACCESS.said);
  });

  it("names the host's line ahead of git's own trailer", () => {
    expect(hostSaid(GITHUB_NOT_FOUND.stderr + GIT_TRAILER)).toBe(GITHUB_NOT_FOUND.said);
  });

  it('drops the carriage return ssh ends its line with', () => {
    expect(hostSaid(keyUnknown('gitlab.com').stderr + GIT_TRAILER)).toBe(
      'git@gitlab.com: Permission denied (publickey).',
    );
  });

  it("falls back to git's trailer where the host said nothing else", () => {
    expect(hostSaid(`remote: \nremote: ====\n${GIT_TRAILER}`)).toBe(
      'fatal: Could not read from remote repository.',
    );
  });

  it('is empty for an empty stderr, and keeps at most 300 characters', () => {
    expect(hostSaid('')).toBe('');
    expect(hostSaid(`remote: ${'x'.repeat(400)}`)).toHaveLength(300);
  });
});

describe('fetchRefusal, in the words each host sends', () => {
  it.each([
    GITLAB_NO_ACCESS,
    GITHUB_NOT_FOUND,
    keyUnknown('gitlab.com'),
    keyUnknown('github.com'),
    NO_REPOSITORY,
    unreachable('172.65.251.78'),
  ])("names what $name said, and never stops at a bare 'remote:'", (answer) => {
    const why = refusalOf(answer);
    expect(why).toContain(answer.said);
    expect(why).not.toMatch(/remote:\s*(\.|$|\))/m);
    expect(why).not.toMatch(/GitHub binding|Integrations/);
  });

  it.each([GITLAB_NO_ACCESS, GITHUB_NOT_FOUND, NO_REPOSITORY])(
    'reads $name as a key the host took that may not read the repository',
    (answer) => {
      const why = refusalOf(answer);
      expect(why).toContain(
        `the git host took the deploy key attached to this project but will not let it read ${REMOTE}`,
      );
      expect(why).toContain(`give the deploy key attached under ${GIT_ACCESS} ${ASK}`);
      expect(why).toContain('correct the SSH clone URL set there');
    },
  );

  it.each([keyUnknown('gitlab.com'), keyUnknown('github.com')])(
    'reads $name as a key the host refused, naming the repository to add it to',
    (answer) => {
      expect(refusalOf(answer)).toBe(
        `the git host refused the deploy key attached to this project (${answer.said}) — give its public key write access to ${REMOTE}, since Forge reads the repository with it and the project's runner pushes with it; the key is the one attached under ${GIT_ACCESS}`,
      );
    },
  );

  // ISS-1398 judge j2 finding 2: "the git host <url> names could not be reached" did not parse.
  it('names the host that could not be reached, then the URL to check, with no word about access', () => {
    const answer = unreachable('172.65.251.78');
    const why = refusalOf(answer);
    expect(why).toMatch(/^the git host gitlab\.com could not be reached \(ssh: connect to host /);
    expect(why).toContain(answer.said);
    expect(why).not.toContain(`${REMOTE} names`);
    expect(why).toContain('the deploy key was never offered');
    expect(why).toContain(`check that the SSH clone URL ${REMOTE}, set under ${GIT_ACCESS}`);
    expect(why).not.toMatch(/(read|write) access/);
  });

  // ISS-1398 judge j2 finding 1: the mark and the hold asked for read access, Test connection for write.
  it.each([GITLAB_NO_ACCESS, keyUnknown('gitlab.com')])(
    'asks for write access for $name, as Test connection does, and never for read access',
    (answer) => {
      const why = refusalOf(answer);
      expect(why).toContain('write access');
      expect(why).toContain(
        "since Forge reads the repository with it and the project's runner pushes with it",
      );
      expect(why).not.toContain('read access');
    },
  );

  it('holds the act that clears a refusal apart from its cause', () => {
    const said = hostRefusal({ stderr: GITLAB_NO_ACCESS.stderr + GIT_TRAILER, code: 128 }, REMOTE);
    expect(said.cause).toBe(
      `the git host took the deploy key attached to this project but will not let it read ${REMOTE} (${GITLAB_NO_ACCESS.said})`,
    );
    expect(said.clears).toContain(ASK);
    expect(refusalOf(GITLAB_NO_ACCESS)).toBe(`${said.cause} — ${said.clears}`);
  });

  it.each([
    ['ssh: Could not resolve hostname git.example.org: Name or service not known'],
    ['ssh: connect to host 172.65.251.78 port 22: Connection refused'],
    ['ssh: connect to host 172.65.251.78 port 22: No route to host'],
    ['ssh: connect to host 172.65.251.78 port 22: Network is unreachable'],
  ])('reads %s as unreachable', (line) => {
    expect(fetchRefusal({ stderr: `${line}\r\n${GIT_TRAILER}`, code: 128 }, REMOTE)).toContain(
      'could not be reached',
    );
  });

  it('names a branch the repository does not have, with no word about the key', () => {
    const why = fetchRefusal(
      { stderr: "fatal: couldn't find remote ref refs/heads/staging\n", code: 128 },
      REMOTE,
    );
    expect(why).toBe('the repository has no branch staging, so it cannot be compared');
  });

  it("quotes any other answer whole, and git's exit status where there is none", () => {
    expect(
      fetchRefusal(
        { stderr: 'remote: \nfatal: protocol error: bad pack header\n', code: 128 },
        REMOTE,
      ),
    ).toBe('the git host answered the fetch with: fatal: protocol error: bad pack header');
    expect(fetchRefusal({ stderr: '', code: 128 }, REMOTE)).toBe(
      'the git host answered the fetch with: git exited 128',
    );
  });
});
