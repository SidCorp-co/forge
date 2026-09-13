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

  // cm:guard the OTHER direction, and the one criterion 35 is about: three named files in the
  // Rocket.Chat tree reach the store — its ports, its inbound runtime, its escalation runtime.
  // cm:why a FOURTH is the thing to stop: each of these is this transport's own runtime reaching its
  // own room, and the day the list grows for any other reason is the day it stops meaning anything.
  it('is reached from the Rocket.Chat tree by its three runtime files and nothing else', () => {
    const rc = fileURLToPath(new URL('../integrations/rocketchat/', import.meta.url));
    const reaching = readdirSync(rc)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => /from '(\.\.\/)+conversations\//.test(readFileSync(`${rc}${f}`, 'utf8')));
    expect(reaching.sort()).toEqual([
      'connection-manager.ts',
      'conversation-port.ts',
      'escalation-bridge.ts',
    ]);
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
