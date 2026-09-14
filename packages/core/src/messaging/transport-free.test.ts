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

  // cm:guard the option-line pattern is the one thing a transport still owns and the rule still needs, and it arrives on `MessageFacts` as data. A rule that imported it would put a Rocket.Chat rendering concern inside the contract and the two tests above would go red — this one says so before they do.
  it('takes the option-line pattern as data rather than importing one', () => {
    const rules = readFileSync(`${dir}text-rules.ts`, 'utf8');
    expect(rules).toContain('f.optionLinePattern');
    expect(rules).not.toContain('OPTION_LINE_RE');
  });
});
