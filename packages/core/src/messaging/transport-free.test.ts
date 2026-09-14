import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));

// cm:guard there is no exception list and there must not become one. The three screens this module replaced all lived inside `integrations/rocketchat/`, which is exactly why a message's rules were decided by the door it left through rather than by who was going to read it (ISS-997).
const TRANSPORT_WORDS = [
  'rocketchat',
  'RocketChat',
  'telegram',
  'Telegram',
  'widget',
  'slack',
  'Slack',
  'discord',
  'ddp',
];

const sourceFiles = (): string[] =>
  readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));

describe('the message contract knows no transport', () => {
  it('has modules to measure', () => {
    expect(sourceFiles().length).toBeGreaterThan(5);
  });

  it('names no transport in any module', () => {
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      for (const word of TRANSPORT_WORDS) {
        if (text.includes(word)) offences.push(`${file} names "${word}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('imports nothing from the integrations tree', () => {
    const offences: string[] = [];
    for (const file of sourceFiles()) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      if (/from '(\.\.\/)+integrations\//.test(text)) offences.push(file);
    }
    expect(offences).toEqual([]);
  });

  // cm:guard the option-line grammar moved INTO the contract rather than being passed into it, and the adapter re-exports it. One constant is what keeps the rule that refuses a colliding label and the renderer that would have rendered it from drifting; two would let a label start rendering as an option the rule had already let through.
  it('owns the option-line grammar rather than borrowing one from an adapter', () => {
    expect(readFileSync(`${dir}option-line.ts`, 'utf8')).toContain('OPTION_LINE_RE');
    const renderer = readFileSync(
      new URL('../integrations/rocketchat/question-render.ts', import.meta.url),
      'utf8',
    );
    expect(renderer).toContain("export { OPTION_LINE_RE } from '../../messaging/option-line.js'");
  });
});
