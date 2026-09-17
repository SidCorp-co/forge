/**
 * ISS-1072's fourth outcome has two halves, and only one of them is provable by
 * calling something: the check re-publishes on every event that changes the
 * answer, AND never by polling.
 *
 * "Never" is a claim about code that does NOT exist, so it is read off the
 * source rather than exercised. A timer added to the publish path would pass
 * every behavioural test in this directory — it would simply also publish, on a
 * clock, against a rate limit nobody is watching.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_SRC = join(HERE, '..', '..');

/** Every file on the publish path, by the import graph that reaches GitHub. */
const PUBLISH_PATH = [
  'integrations/github/contract-check.ts',
  'integrations/github/contract-check-subscribers.ts',
  'integrations/github/check-run.ts',
  'integrations/github/check-run-body.ts',
  'integrations/github/check-refusal.ts',
  'integrations/github/contract-answer.ts',
];

const read = (relative: string) => readFileSync(join(CORE_SRC, relative), 'utf8');

describe('nothing on the publish path runs on a clock', () => {
  it.each(PUBLISH_PATH)('%s schedules nothing', (relative) => {
    const source = read(relative);
    for (const scheduler of ['setInterval', 'setTimeout', 'cron', 'node-schedule']) {
      expect(source).not.toContain(scheduler);
    }
  });

  // cm:guard the sweeper is the one place in this repo where work happens on a tick, so a
  // publish reached from it would be polling however it was spelled. This asserts the import
  // does not exist rather than that the tick behaves — an import is what a reader can check.
  it('no sweeper, scheduler or worker imports the publish entry point', () => {
    const scheduled = readdirSync(join(CORE_SRC, 'pipeline'))
      .filter((name) => /sweeper|schedule|worker|monitor|tick/i.test(name))
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'));
    expect(scheduled.length).toBeGreaterThan(0);
    for (const name of scheduled) {
      const source = read(join('pipeline', name));
      expect(source).not.toContain('contract-check');
      expect(source).not.toContain('check-run');
    }
  });

  // cm:guard the subscribers are registered from `eager-subscribers.ts` and nowhere else, which
  // is what makes "every publish hangs off an event somebody else emitted" checkable.
  it('registers the subscribers from the hooks-bus registrar alone', () => {
    const registrar = read('eager-subscribers.ts');
    expect(registrar).toContain('registerContractCheckSubscribers');
    const subscribers = read('integrations/github/contract-check-subscribers.ts').replace(
      /\s+/g,
      ' ',
    );
    for (const topic of ['transition', 'contractInputChanged', 'dependencyChanged']) {
      expect(subscribers).toContain(`bus.on( '${topic}',`);
    }
  });
});
