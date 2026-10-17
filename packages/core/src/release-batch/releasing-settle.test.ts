/**
 * The releasing sweep runs on a schedule of its own: registered once at boot, every minute, and its
 * worker is the pass. The pass itself is proved on real Postgres in
 * `tests/integration/releasing-settle-e2e.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const boss = vi.hoisted(() => ({
  createQueue: vi.fn(async () => undefined),
  work: vi.fn(async () => undefined),
  schedule: vi.fn(async () => undefined),
}));
vi.mock('../queue/boss.js', () => ({ boss }));
const execute = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../db/client.js', () => ({ db: { execute } }));

const { registerReleasingSettle, resetReleasingSettleForTest } = await import(
  './releasing-settle.js'
);

describe('registerReleasingSettle (ISS-1421)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetReleasingSettleForTest();
  });

  it('creates its queue, works it, and schedules it every minute', async () => {
    await registerReleasingSettle();

    expect(boss.createQueue).toHaveBeenCalledWith('release-batch-releasing-settle');
    expect(boss.work).toHaveBeenCalledWith('release-batch-releasing-settle', expect.any(Function));
    expect(boss.schedule).toHaveBeenCalledWith('release-batch-releasing-settle', '* * * * *');
  });

  it('registers once however often it is called', async () => {
    await registerReleasingSettle();
    await registerReleasingSettle();

    expect(boss.schedule).toHaveBeenCalledTimes(1);
  });

  it('works the queue with the pass, which reads the rows at Releasing', async () => {
    await registerReleasingSettle();
    const worker = (boss.work.mock.calls[0] as unknown as [string, () => Promise<void>])[1];
    execute.mockClear();

    await worker();

    expect(execute).toHaveBeenCalledTimes(1);
  });
});

// ISS-1421 r4 — judge-32 read the no-verify-probe finding at 27 words and the outside-git one at
// 30. Every comment the sweep can write, under every shape, hold and finding, is walked here: each
// sentence opens with a capital, ends with a full stop and runs to at most 25 words. A reason
// another system gave stands on a quoted line of its own and is not the sweep's sentence.
describe("the releasing sweep's comment (ISS-1421 r4)", async () => {
  const { recordRefusedComment, settleComment, strandedCause } = await import(
    './releasing-settle.js'
  );
  const { releaseRunStopped } = await import('./run-ended-words.js');
  type Comment = Parameters<typeof settleComment>;

  const CAUSES = [
    strandedCause({ release_batch_run_id: null, run_status: null, run_exists: false }),
    strandedCause({ release_batch_run_id: 'r', run_status: null, run_exists: false }),
    ...['failed', 'cancelled', 'completed', null].map((s) =>
      strandedCause({ release_batch_run_id: 'r', run_status: s, run_exists: true }),
    ),
  ];
  const SERVING = 'a1b2c3d4e5f6';
  const LANDING = '0f9e8d7c6b5a';
  const FINDINGS: Comment[1][] = [
    { kind: 'carried', serving: SERVING, servingWhole: SERVING, landing: LANDING },
    { kind: 'not-carried', serving: SERVING, landing: LANDING },
    { kind: 'unverified' },
    { kind: 'no-landing' },
    { kind: 'outside-git' },
    { kind: 'not-read' },
    {
      kind: 'unread',
      why: 'the probe at https://shop.example/version answered 503 Service Unavailable',
    },
  ] as Comment[1][];
  const PATHS: Comment[2][] = ['gated', 'ships-nothing', 'no-live-target', 'unread'];
  const HOLDS: Comment[3][] = [
    { kind: 'read', holds: [] },
    {
      kind: 'read',
      holds: [
        { reason: 'not marked merged', clears: "Use Mark merged in the issue's properties." },
        { reason: 'holds 2 open questions', clears: 'Answer them on the issue.' },
      ],
    },
    { kind: 'unread' },
  ];
  const DOORS: Comment[4][] = [
    { addLiveTarget: null },
    {
      addLiveTarget:
        'https://forge.example/projects/a/settings?tab=integrations&add=live-deploy-target',
    },
  ];

  /** The comment's own sentences: markdown emphasis dropped, quoted lines left out. */
  function sentencesOf(comment: string): string[] {
    return comment
      .split('\n\n')
      .filter((paragraph) => !paragraph.startsWith('> '))
      .map((paragraph) => paragraph.replace(/\*\*/g, ''))
      .flatMap((paragraph) => paragraph.split(/(?<=[.!?])\s+(?=[A-Z`])/));
  }

  function faultsOf(sentence: string): string[] {
    const faults: string[] = [];
    if (!/^[A-Z`]/.test(sentence)) faults.push('does not open with a capital');
    if (!/[.]$/.test(sentence)) faults.push('does not end with a full stop');
    const words = sentence.split(/\s+/).filter(Boolean).length;
    if (words > 25) faults.push(`runs to ${words} words`);
    return faults;
  }

  function everyComment(): string[] {
    const out: string[] = [];
    for (const cause of CAUSES)
      for (const finding of FINDINGS)
        for (const path of PATHS)
          for (const holds of HOLDS)
            for (const doors of DOORS) out.push(settleComment(cause, finding, path, holds, doors));
    for (const holds of HOLDS)
      out.push(recordRefusedComment('the release record door refused it', holds));
    return out;
  }

  it('says each sentence short and whole', () => {
    const faulty = everyComment()
      .flatMap(sentencesOf)
      .map((sentence) => ({ sentence, faults: faultsOf(sentence) }))
      .filter((s) => s.faults.length > 0);
    expect(faulty).toEqual([]);
  });

  it('keeps a reason another system gave whole, on a quoted line', () => {
    const said = settleComment(
      CAUSES[0] as string,
      FINDINGS[6] as Comment[1],
      'gated',
      HOLDS[0] as Comment[3],
    );
    expect(said).toContain(
      '\n\n> the probe at https://shop.example/version answered 503 Service Unavailable',
    );
    expect(releaseRunStopped('failed')).toBe(
      'The release run failed without finishing its release',
    );
  });

  it('a sentence that breaks the rule is caught', () => {
    expect(faultsOf(`This ${'long '.repeat(30).trim()} sentence.`)).toEqual(['runs to 32 words']);
    expect(sentencesOf('**Bold.** Two. Three\n\n> quoted. text')).toEqual([
      'Bold.',
      'Two.',
      'Three',
    ]);
  });
});
