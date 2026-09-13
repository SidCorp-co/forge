import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));

// cm:guard there is no exception list and there must not become one: the Forge UI's own adapter
// surface lives in `assistant/conversation-routes.ts` precisely so nothing here needs carving out.
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

function storeFiles(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

describe('the conversation store knows no transport', () => {
  it('has store files to measure', () => {
    expect(storeFiles().length).toBeGreaterThan(3);
  });

  // cm:guard this is the structural half of "Rocket.Chat becomes an adapter": the machine was extracted from 49 Rocket.Chat files, and the only thing that keeps it extracted is that naming one here fails CI. `outbound.test.ts` holds the same shape over the single delivery door (ISS-1001 criterion 32).
  it('names no transport in any store module', () => {
    const offences: string[] = [];
    for (const file of storeFiles()) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      for (const word of TRANSPORT_WORDS) {
        if (text.includes(word)) offences.push(`${file} names "${word}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  it('imports nothing from the integrations tree', () => {
    const offences: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      if (/from '(\.\.\/)+integrations\//.test(text)) offences.push(`${file}`);
    }
    expect(offences).toEqual([]);
  });
});
