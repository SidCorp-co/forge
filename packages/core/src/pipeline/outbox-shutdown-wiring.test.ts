// ISS-830 — the integration test proves `stopOutboxWorker()` settles its claims.
// This proves the shutdown path actually CALLS it, which is the line that was
// missing. Importing index.ts to test `runShutdown` would boot a server, so the
// wiring is asserted structurally instead — the same trade the outbound-path
// scan makes elsewhere.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const indexPath = fileURLToPath(new URL('../index.ts', import.meta.url));
const src = readFileSync(indexPath, 'utf8');

/** The `const sequence = (async () => { … })()` block inside `runShutdown`. */
function shutdownSequence(): string {
  const start = src.indexOf('const sequence = (async');
  expect(start).toBeGreaterThan(-1);
  const end = src.indexOf('})();', start);
  expect(end).toBeGreaterThan(start);
  return src.slice(start, end);
}

describe('shutdown wiring (ISS-830)', () => {
  // cm:guard removing this call costs no test elsewhere and no error at runtime — the process just exits with rows still claimed, and every restart landing mid-drain adds up to CLAIM_LEASE_MS of dispatch latency that no alarm covers
  it('runShutdown stops the outbox worker', () => {
    expect(shutdownSequence()).toContain('await stopOutboxWorker();');
  });

  // cm:why matched with the `await …;` prefix, not the bare name — the guard comment
  // beside the call names both functions in prose, and a bare-name scan reads that first
  it('stops it BEFORE closing the db — settling a claim needs a live connection', () => {
    const seq = shutdownSequence();
    expect(seq.indexOf('await stopOutboxWorker();')).toBeLessThan(seq.indexOf('await closeDb();'));
  });

  it('imports it from the module that owns the claim lifecycle', () => {
    expect(src).toMatch(
      /import \{[^}]*stopOutboxWorker[^}]*\} from '\.\/pipeline\/outbox-worker\.js'/,
    );
  });
});
