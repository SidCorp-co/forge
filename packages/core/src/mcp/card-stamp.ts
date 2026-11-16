// `pnpm --filter @forge/core cards:stamp [ISS-n]`: writes the card ledger (`lib/card-changes.json`)
// from the cards this build serves, so a card's `changed` is the day its text last changed and the
// issue that changed it, never a date written by hand. The issue is the argument, or the one the
// branch is named for; neither is refused by name.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { enterHermeticEnv } from '../api-contract/hermetic-env.js';
import { CARD_LEDGER } from '../lib/card-changed.js';

const LEDGER = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'card-changes.json');

function issue(): string {
  const given = process.argv[2];
  if (given) return given;
  const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' });
  const n = /iss-?(\d+)/i.exec(branch)?.[1];
  return n ? `ISS-${n}` : '';
}

const by = issue();
if (!/^ISS-\d+$/.test(by)) {
  throw new Error(
    `cards:stamp: name the issue whose landing changes the cards (cards:stamp ISS-n); the branch names none and "${by}" is not ISS-n`,
  );
}
// the cards are read off the registry the default build serves, as the contract generator reads it
enterHermeticEnv();
const { everyCard, ledgerDrift, stampedLedger } = await import('./card-ledger.js');
const cards = everyCard();
const drift = ledgerDrift(cards, CARD_LEDGER);
const ledger = stampedLedger(cards, CARD_LEDGER, new Date().toISOString().slice(0, 10), by);
writeFileSync(LEDGER, `${JSON.stringify(ledger, null, 2)}\n`);
process.stdout.write(
  `cards:stamp: ${drift.unstamped.length} card(s) stamped ${by}, ${drift.gone.length} gone, ${cards.length} in the ledger\n`,
);
