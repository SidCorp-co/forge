// The ecosystem inbox guide's publishing steps are rendered from the cards of the doors they act
// through (ISS-1251): the interface write and the contract version's publish and decide. The guide
// keeps the method and how a change is measured; each door's shapes and refusals are its card's.

import { capabilityCardSchema } from '@forge/contracts/capability-cards';
import { describe, expect, it } from 'vitest';
import { CARDS } from '../ecosystem/tool.cards.js';
import { provideDoorCatalog } from '../lib/door-catalog.js';
import { servedDoorCatalog } from '../mcp/door-catalog.js';
import { ECOSYSTEM_INBOX_GUIDE } from './ecosystem-inbox-guide.js';
import { servedGuideBody } from './served.js';

provideDoorCatalog({ doorCatalog: servedDoorCatalog, doorCalls: async () => new Map() });

const flat = (text: string) => text.split(/\s+/).join(' ');

describe('the ecosystem inbox guide publishes through its doors’ cards (ISS-1251)', () => {
  it('serves the interface write and version cards beneath its method', () => {
    const served = flat(servedGuideBody(ECOSYSTEM_INBOX_GUIDE));
    for (const act of ['interface_write', 'contract_version_publish', 'contract_version_decide'] as const) {
      const card = capabilityCardSchema.parse(CARDS[act]);
      for (const line of card.practice) expect(served).toContain(flat(line));
    }
    // how a change is measured is the guide's own prose, not a door's
    expect(served).toContain('graphql-inspector measures the change');
  });

  it('keeps no copy of what the cards say', () => {
    const body = flat(ECOSYSTEM_INBOX_GUIDE.body);
    for (const copy of [
      'deprecationNoticeDays',
      '`mcp-tools` takes',
      'CONTRACT_SOURCE_DIGEST_MISMATCH',
      'VERSION_BUMP_TOO_SMALL',
      'Writing either takes `contracts.write`',
    ]) {
      expect(body, `the guide holds ${copy} again`).not.toContain(copy);
    }
  });
});
