#!/usr/bin/env node

// Form axis (REQ-12 BC-18, ISS-1175): every outbox event type names a consumer. An emitted event
// with none is a row and a delivery nobody reads; `source.merged` was one for a year (ISS-822). The
// type on `OUTBOX_CONSUMERS` already refuses an empty list, but its error names a line, not the
// event; this refuses each by name, `OUTBOX_EVENT_UNCONSUMED <type>`. The rules are in
// `scripts/lib/outbox-consumers.mjs`.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dieAs, ROOT } from './lib/gate.mjs';
import { readConsumerCounts, readEventTypes, unconsumedFaults } from './lib/outbox-consumers.mjs';

const die = dieAs('check-outbox-consumers');
const EVENTS = 'packages/contracts/src/outbox-events.ts';
const CONSUMERS = 'packages/contracts/src/outbox-consumers.ts';

function read(rel) {
  try {
    return readFileSync(join(ROOT, rel), 'utf8');
  } catch (err) {
    return die(`could not read ${rel}: ${err.message}`);
  }
}

const events = readEventTypes(EVENTS, read(EVENTS));
if (events.unreadable) die(events.unreadable);
const consumers = readConsumerCounts(CONSUMERS, read(CONSUMERS));
if (consumers.unreadable) die(consumers.unreadable);

const faults = unconsumedFaults(events.types, consumers.counts);
console.log(`outbox-consumers: ${events.types.length} event type(s) declared`);
if (faults.length === 0) process.exit(0);

for (const f of faults) console.error(`  ${f}`);
console.error(
  `\ncheck-outbox-consumers: ${faults.length} event type(s) name no consumer in ${CONSUMERS}.\n` +
    'Stop emitting each and remove it from OUTBOX_EVENT_TYPES, or name the consumer that reads it.',
);
process.exit(1);
