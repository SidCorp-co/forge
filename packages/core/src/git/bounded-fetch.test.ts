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
const REPO_URL_AT = "the project's Settings → Shape & release → Repository";
/** What every sentence asks the key be given, and why: Test connection's too (`ssh-keys.test.ts`). */
const WHY = 'which is all Forge needs; devices that push with it need write access';
const ASK = `read access to ${REMOTE}, ${WHY}`;

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
        `The git host took this project's deploy key but will not let it read ${REMOTE}.`,
      );
      expect(why).toContain(`Give that key ${ASK}.`);
      expect(why).toContain(`If none lives there, fix the SSH clone URL under ${REPO_URL_AT}.`);
    },
  );

  it.each([keyUnknown('gitlab.com'), keyUnknown('github.com')])(
    'reads $name as a key the host refused, naming the repository to add it to',
    (answer) => {
      expect(refusalOf(answer)).toBe(
        `The git host refused this project's deploy key. Give the key read access to ${REMOTE}, which is all Forge needs; devices that push with it need write access. It is under ${GIT_ACCESS}.\n${answer.said}`,
      );
    },
  );

  // ISS-1398 judge j2 finding 2: "the git host <url> names could not be reached" did not parse.
  it('names the host that could not be reached, then the URL to check, with no word about access', () => {
    const answer = unreachable('172.65.251.78');
    const why = refusalOf(answer);
    expect(why).toMatch(
      /^The git host gitlab\.com could not be reached, so the deploy key was never offered\./,
    );
    expect(why.split('\n')[1]).toContain(answer.said);
    expect(why).toContain(`Check that the SSH clone URL ${REMOTE} names the right host`);
    expect(why).toContain(`It is set under ${REPO_URL_AT}.`);
    expect(why).not.toMatch(/(read|write) access/);
  });

  // ISS-1398 judge j2 finding 1: the mark and the hold asked for read access, Test connection for
  // write; one clause words all three. r11: judge-52 read it asking for write access so Forge could
  // read, where read access is all Forge needs and the devices pushing with the key need write.
  it.each([GITLAB_NO_ACCESS, keyUnknown('gitlab.com')])(
    'asks for read access for $name, as Test connection does, naming the write devices need apart',
    (answer) => {
      const why = refusalOf(answer);
      expect(why).toContain(`read access to ${REMOTE}, ${WHY}.`);
      expect(why).not.toMatch(/Give (?:the|that) key write access/);
      expect(why).not.toContain('runner pushes');
    },
  );

  it('holds the act that clears a refusal apart from its cause', () => {
    const said = hostRefusal({ stderr: GITLAB_NO_ACCESS.stderr + GIT_TRAILER, code: 128 }, REMOTE);
    expect(said.cause).toBe(
      `the git host took this project's deploy key but will not let it read ${REMOTE}`,
    );
    expect(said.clears).toContain(ASK);
    expect(said.said).toContain(GITLAB_NO_ACCESS.said);
    expect(refusalOf(GITLAB_NO_ACCESS)).toBe(
      `The git host took this project's deploy key but will not let it read ${REMOTE}. ${said.clears?.charAt(0).toUpperCase()}${said.clears?.slice(1)}.\n${said.said}`,
    );
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
    expect(why).toBe('The repository has no branch staging, so it cannot be compared.');
  });

  it("quotes any other answer whole, and git's exit status where there is none", () => {
    expect(
      fetchRefusal(
        { stderr: 'remote: \nfatal: protocol error: bad pack header\n', code: 128 },
        REMOTE,
      ),
    ).toBe('The git host refused the fetch.\nfatal: protocol error: bad pack header');
    expect(fetchRefusal({ stderr: '', code: 128 }, REMOTE)).toBe(
      'The fetch failed, and git exited 128.',
    );
  });
});

// ISS-1421 r9 repair: the coordinator read this reason under a mark as one ~50-word sentence with an
// em dash and the host's words in brackets inside it, which rendered as "( git@github.com : …)".
// Worded here, every surface quoting it gets: at most three short sentences, no dash, and the
// host's own line apart from them, whole.
describe('the git-access refusal reads in short sentences, the host apart (ISS-1421 r9)', () => {
  it.each([
    keyUnknown('github.com'),
    GITLAB_NO_ACCESS,
    GITHUB_NOT_FOUND,
    unreachable('172.65.251.78'),
  ])('words $name in at most three short sentences, the host line on its own', (answer) => {
    const [ours, ...host] = refusalOf(answer).split('\n');
    expect(host).toHaveLength(1);
    expect(host[0]).toContain(answer.said);
    expect(ours).not.toContain(answer.said);
    expect(ours).not.toMatch(/ — | – /);
    const sentences = (ours as string).split(/(?<=\.)\s+(?=[A-Z])/);
    expect(sentences.length, ours).toBeLessThanOrEqual(3);
    for (const one of sentences) {
      expect(one, one).toMatch(/^[A-Z]/);
      expect(one, one).toMatch(/\.$/);
      expect(one.split(/\s+/).length, one).toBeLessThanOrEqual(20);
    }
  });

  it('says a refused key in the words the coordinator asked for', () => {
    expect(refusalOf(keyUnknown('github.com')).split('\n')[0]).toBe(
      "The git host refused this project's deploy key. Give the key read access to " +
        `${REMOTE}, which is all Forge needs; devices that push with it need write access. It is under ${GIT_ACCESS}.`,
    );
  });
});
