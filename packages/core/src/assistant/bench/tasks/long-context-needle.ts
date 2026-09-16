import type { Task } from '../task.js';

const TOPICS = [
  'the ingest worker',
  'the notification fan-out',
  'the search index',
  'the billing reconciler',
  'the device pairing flow',
  'the audit log writer',
  'the export scheduler',
  'the webhook retrier',
  'the session sweeper',
  'the attachment scanner',
];
const VERBS = [
  'now retries three times before it gives up',
  'reads its batch size from the project config',
  'logs one line per batch instead of one per row',
  'no longer holds a transaction across the network call',
  'answers a malformed row with a 400 that names the field',
  'was moved behind the same advisory lock as its sibling',
  'reports its queue depth to the metrics endpoint',
  'drops rows older than the retention window on start',
  'validates its input against the shared schema',
  'runs at four in the morning UTC and never twice a day',
];
const TAILS = [
  'Operators saw no change in throughput.',
  'The dashboard row for it was renamed to match.',
  'A regression test plants the old failure and watches it go red.',
  'The change was measured on staging for a week first.',
  'Nothing in the public API moved.',
  'The runbook paragraph for it was rewritten.',
  'Two follow-up tickets were closed as duplicates.',
  'The rollout was gated behind a flag for one release.',
];

/** About 1,800 words of plausible release notes, deterministic, with one fact planted near the middle. */
function releaseNotes(): string {
  const paragraphs: string[] = [];
  let n = 0;
  for (let p = 0; p < 16; p += 1) {
    const sentences: string[] = [];
    for (let s = 0; s < 7; s += 1) {
      const topic = TOPICS[n % TOPICS.length] ?? '';
      const verb = VERBS[(n * 7) % VERBS.length] ?? '';
      const tail = TAILS[(n * 3) % TAILS.length] ?? '';
      sentences.push(`In build ${1200 + n}, ${topic} ${verb}. ${tail}`);
      n += 1;
    }
    if (p === 8)
      sentences.splice(3, 0, 'The on-call rota for {nonce} turns over on Thursday at 09:00 UTC.');
    paragraphs.push(sentences.join(' '));
  }
  return paragraphs.join('\n\n');
}

/** One fact buried in the middle of a long message; the answer needs no tool, only the whole text read. */
export const longContextNeedle: Task = {
  id: 'long-context-needle',
  capability: 'long-context',
  intent: 'Find one planted fact in a long pasted document and answer from it without tools.',
  judgeRubric:
    'Served means the reply says the rota turns over on Thursday, taken from the pasted notes, without asking for the document again.',
  budgetSeconds: 240,
  fixtures: ['nonce'],
  turns: [
    {
      message: `Here are the release notes I was sent. Read them, then answer the question at the end.\n\n${releaseNotes()}\n\nQuestion: on which weekday does the on-call rota for {nonce} turn over?`,
      checks: [
        { kind: 'mustMatch', patterns: [/thursday/i] },
        { kind: 'maxIterations', max: 3 },
        { kind: 'maxCalls', max: 2 },
        { kind: 'notFallback' },
        { kind: 'noHelp' },
      ],
    },
  ],
};
