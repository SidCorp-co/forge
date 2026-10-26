// A GitHub double answering what a release reads of a repository: compares, a commit's parents,
// and a branch's head. Bound to a project as its GitHub binding through the real connection store,
// so the code under test mints a token and reads through the same client it uses in production.

import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.INTEGRATION_MASTER_KEY ??= 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=';

export interface DoubleCommit {
  sha: string;
  parents: string[];
  message?: string;
}

export interface DoubleCompare {
  status: string;
  files?: string[];
  commits?: DoubleCommit[];
}

export interface GitHubDouble {
  url: string;
  /** Keyed `base...head`, as the path names them; an unknown pair answers 404. */
  compare: Map<string, DoubleCompare>;
  /** A commit's first parent, keyed by sha. */
  parents: Map<string, string>;
  /** A branch's head, keyed by branch name. */
  heads: Map<string, string>;
  asked: string[];
  /** A repository the installation cannot see: GitHub then answers every read of it 404. */
  hidden: boolean;
  reset(): void;
  close(): Promise<void>;
  /** Bind this double to the project as its GitHub repository. */
  bind(projectId: string, ownerId: string): Promise<void>;
}

/** A new App private key on every call, as GitHub gives one: a whole PEM the save doors parse. */
export const freshAppKey = (): string =>
  generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  }).privateKey;

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function compareBody(answer: DoubleCompare): unknown {
  const commits = answer.commits ?? [];
  return {
    status: answer.status,
    files: (answer.files ?? []).map((filename) => ({ filename })),
    total_commits: commits.length,
    commits: commits.map((c) => ({
      sha: c.sha,
      parents: c.parents.map((sha) => ({ sha })),
      commit: { message: c.message ?? `commit ${c.sha.slice(0, 7)}` },
    })),
  };
}

export async function startGitHubDouble(): Promise<GitHubDouble> {
  const compare = new Map<string, DoubleCompare>();
  const parents = new Map<string, string>();
  const heads = new Map<string, string>();
  const asked: string[] = [];
  const state = { hidden: false };
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    asked.push(url);
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.includes('/access_tokens')) {
      return send(201, { token: 'ghs_installation_token', expires_at: '2099-01-01T00:00:00Z' });
    }
    if (state.hidden) return send(404, { message: 'Not Found', status: '404' });
    const path = url.split('?')[0] ?? '';
    const compared = /\/compare\/([^/]+)$/.exec(path);
    if (compared) {
      const answer = compare.get(decodeURIComponent(compared[1] ?? ''));
      if (!answer) return send(404, { message: 'No common ancestor between these commits.' });
      return send(200, compareBody(answer));
    }
    const named = /\/commits\/([^/]+)$/.exec(path)?.[1];
    if (named === undefined) return send(404, { message: `the double serves no ${url}` });
    const ref = decodeURIComponent(named);
    const head = heads.get(ref);
    if (head) return send(200, { sha: head, parents: [] });
    const parent = parents.get(ref);
    if (parent) return send(200, { sha: ref, parents: [{ sha: parent }] });
    // GitHub's answer for a commit a repository it shows does not hold (api.github.com, 2026-10-25).
    return send(422, { message: `No commit found for SHA: ${ref}`, status: '422' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    compare,
    parents,
    heads,
    asked,
    get hidden() {
      return state.hidden;
    },
    set hidden(value: boolean) {
      state.hidden = value;
    },
    reset() {
      state.hidden = false;
      compare.clear();
      parents.clear();
      heads.clear();
      asked.length = 0;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    async bind(projectId: string, ownerId: string) {
      const store = await import('../../src/integrations/store.js');
      const connection = await store.createConnection({
        ownerType: 'user',
        ownerId,
        provider: 'github',
        displayName: 'GitHub App test',
        secrets: { appId: randomUUID(), privateKey, webhookSecret: 'whs' },
      });
      await store.createBinding({
        connectionId: connection.id,
        projectId,
        provider: 'github',
        role: 'service',
        label: '',
        config: { owner: 'SidCorp-co', repo: 'forge', installationId: 1, apiBaseUrl: url },
        integrationSecret: 'whs',
      });
    },
  };
}
