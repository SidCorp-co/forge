import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));

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

  it('owns the option-line grammar rather than borrowing one from an adapter', () => {
    expect(readFileSync(`${dir}option-line.ts`, 'utf8')).toContain('OPTION_LINE_RE');
    const renderer = readFileSync(
      new URL('../integrations/rocketchat/question-render.ts', import.meta.url),
      'utf8',
    );
    expect(renderer).toContain("export { OPTION_LINE_RE } from '../../messaging/option-line.js'");
  });
});
