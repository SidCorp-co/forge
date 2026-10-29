// ISS-594 / FB-168 (REQ-66 BC-9): filing feedback about the forge-plugin's `forge feedback` verb was
// refused FEEDBACK_TARGET_UNKNOWN, because an endpoint named only a route or tool and a CLI project
// provides neither; the one door left was a screen named in words. A project now publishes a `cli`
// contract, its commands are indexed as `<program> <command>`, and a report about a command targets
// it, named and refused like a route or a tool.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeWorld,
  type Doc,
  type EcosystemWorld,
  ok,
  openWorld,
  refusal,
  sender,
} from '../helpers/ecosystem-world.js';

let w: EcosystemWorld;
let say: ReturnType<typeof sender>;

const CLI_V1 = {
  program: 'forge',
  commands: [
    { name: 'feedback', description: 'File product feedback.', options: ['--kind', '--target'] },
    { name: 'record verdict', options: ['--criterion'] },
    { name: 'issue' },
  ],
};

const project = (path: string) => `/api/projects/${w.project.internal}${path}`;
const versions = () => project('/contracts/forge-cli/versions');
const upload = (artifact: unknown, version: string) =>
  say('platform', 'POST', versions(), {
    kind: 'cli',
    artifact: typeof artifact === 'string' ? artifact : JSON.stringify(artifact),
    sourceRef: 'plugin/src/commands.mjs@867ef128',
    version,
  });
const file = (endpoint: string) =>
  say('platform', 'POST', project('/feedback'), { kind: 'bug', title: 'A verb', endpoint });

beforeAll(async () => {
  w = await openWorld();
  say = sender(w);
  ok(
    await say('platform', 'PUT', project('/interface'), {
      baseRevision: null,
      document: {
        $schema: 'https://forge.sidcorp.co/schemas/interface-v1.json',
        version: 1,
        project: w.project.internal,
        publishes: {
          'forge-cli': {
            title: 'forge CLI',
            summary: 'The verbs the forge command serves.',
            type: 'cli',
            artifact: { upload: true },
            lifecycle: 'production',
            ecosystems: [],
          },
        },
        consumes: [],
        commitments: {
          versioning: 'semver',
          deprecationNoticeDays: 30,
          responseDays: { rfi: 3, 'change-request': 7 },
        },
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await closeWorld();
});

describe('c1: a cli contract version is recorded with its commands indexed', () => {
  it('refuses an artifact that is not a cli document, naming what is wrong and where', async () => {
    const bad = await upload(
      { program: 'forge', commands: [{ name: 'record  verdict' }] },
      '1.0.0',
    );
    expect(refusal(bad)).toEqual(['ARTIFACT_UNREADABLE /artifact']);
    expect(bad.json.error.refusals[0].detail).toContain('commands[0].name');
    const twice = await upload(
      { program: 'forge', commands: [{ name: 'issue' }, { name: 'issue' }] },
      '1.0.0',
    );
    expect(refusal(twice)).toEqual(['ARTIFACT_UNREADABLE /artifact']);
    expect(twice.json.error.refusals[0].detail).toContain('"issue" twice');
  });

  it('records 1.0.0 and indexes each command as <program> <command>, each option as its part', async () => {
    const made = ok(await upload(CLI_V1, '1.0.0'), 201);
    expect(made.version.diff.classification).toBe('initial');
    const read = ok(await say('platform', 'GET', `${versions()}/1.0.0`));
    expect([...read.elements].sort()).toEqual([
      'forge feedback',
      'forge feedback/options/--kind',
      'forge feedback/options/--target',
      'forge issue',
      'forge record verdict',
      'forge record verdict/options/--criterion',
    ]);
  });

  it('measures a removed command as breaking, owing a MAJOR', async () => {
    const r = await upload({ ...CLI_V1, commands: CLI_V1.commands.slice(0, 2) }, '1.1.0');
    expect(refusal(r)).toEqual(['VERSION_BUMP_TOO_SMALL /version']);
    expect(r.json.error.refusals[0].detail).toContain('2.0.0');
  });
});

describe('c2: an endpoint naming a served command targets it', () => {
  it('lists the commands, never their options, among what the project serves', async () => {
    // a first version may be recorded already approved; one that waits proposed serves nothing
    // until a holder of contracts.approve approves it
    const first = ok(await say('platform', 'GET', `${versions()}/1.0.0`));
    if (first.approval.state === 'proposed') {
      ok(await say('platform', 'POST', `${versions()}/1.0.0/decision`, { decision: 'approve' }));
    }
    expect(ok(await say('platform', 'GET', versions())).current).toBe('1.0.0');
    const served = ok(await say('platform', 'GET', project('/feedback/endpoints'))).endpoints;
    expect((served as Doc[]).map((s) => s.key)).toEqual([
      'forge-cli:forge feedback',
      'forge-cli:forge issue',
      'forge-cli:forge record verdict',
    ]);
    expect((served as Doc[]).every((s) => s.type === 'cli')).toBe(true);
  });

  it('files a report about `forge feedback`, keyed by the contract that serves it', async () => {
    const made = ok(await file('forge feedback'), 201).feedback;
    expect(made.target).toEqual({
      type: 'endpoint',
      key: 'forge-cli:forge feedback',
      title: 'forge-cli 1.0.0',
    });
  });

  it('takes the command qualified by its contract', async () => {
    const made = ok(await file('forge-cli:forge record verdict'), 201).feedback;
    expect(made.target.key).toBe('forge-cli:forge record verdict');
  });
});

describe('c3: a command the contract does not serve is refused, naming the served ones', () => {
  it('refuses `forge nope`, naming the commands the project serves', async () => {
    const r = await file('forge nope');
    expect(refusal(r)).toEqual(['FEEDBACK_TARGET_UNKNOWN /endpoint']);
    const detail = r.json.error.refusals[0].detail as string;
    expect(detail).toContain('forge-cli:forge feedback');
    expect(detail).toContain('forge-cli:forge record verdict');
    expect(detail).toContain('command');
  });

  it('refuses an option, which is part of a command and not one', async () => {
    const r = await file('forge feedback/options/--kind');
    expect(refusal(r)).toEqual(['FEEDBACK_TARGET_UNKNOWN /endpoint']);
  });
});
