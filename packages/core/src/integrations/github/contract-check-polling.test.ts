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
