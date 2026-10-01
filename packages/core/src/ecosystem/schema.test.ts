import { describe, expect, it } from 'vitest';
import { parseVersionedDocument } from '../project-config/documents.js';
import {
  clone,
  type Doc,
  ecosystemRefusals,
  emittedAccepts,
  example,
  exampleFiles,
  interfaceRefusals,
} from './ecosystem.fixture.js';
import { membershipDocumentSchema } from './schema.js';

describe('the emitted JSON Schemas and the zod sources agree on the design examples', () => {
  it('reads every example', () => {
    expect(exampleFiles()).toHaveLength(14);
  });

  it.each(exampleFiles())('accepts %s', (file) => {
    const doc = example(file);
    expect(emittedAccepts(doc)).toBe(true);
    if (file.endsWith('.interface.json')) expect(interfaceRefusals(doc)).toEqual([]);
    if (file.endsWith('.ecosystem.json')) expect(ecosystemRefusals(doc)).toEqual([]);
    if (file.endsWith('.membership.json')) {
      expect(parseVersionedDocument(membershipDocumentSchema, doc, 'membership').ok).toBe(true);
    }
  });
});

const eco = () => example('forge-platform.ecosystem.json');
const mem = () => example('forge-plugin.membership.json');
const pif = () => example('forge-plugin.interface.json');

const plants: [string, () => Doc, 'ecosystem' | 'membership' | 'interface', string, string][] = [
  [
    'a silent gate mode',
    () => {
      const d = eco();
      d.gate.decision = 'silent';
      return d;
    },
    'ecosystem',
    'SCHEMA_VIOLATION',
    '/gate/decision',
  ],
  [
    'a gate that omits a type',
    () => {
      const d = eco();
      delete d.gate.rfi;
      return d;
    },
    'ecosystem',
    'SCHEMA_VIOLATION',
    '/gate/rfi',
  ],
  [
    'a lowercase channel code',
    () => {
      const d = eco();
      d.channel.code = 'fp';
      return d;
    },
    'ecosystem',
    'SCHEMA_VIOLATION',
    '/channel/code',
  ],
  [
    'a key version 1 does not define',
    () => ({ ...eco(), members: [] }),
    'ecosystem',
    'UNKNOWN_KEY',
    '/members',
  ],
  [
    'left without a reason',
    () => {
      const d = mem();
      d.state = 'left';
      return d;
    },
    'membership',
    'SCHEMA_VIOLATION',
    '',
  ],
  [
    'a membership state outside the lifecycle',
    () => {
      const d = mem();
      d.state = 'pending';
      return d;
    },
    'membership',
    'SCHEMA_VIOLATION',
    '/state',
  ],
  [
    'a contract type outside the vocabulary',
    () => {
      const d = pif();
      d.publishes['driver-skill'].type = 'swagger';
      return d;
    },
    'interface',
    'CONTRACT_TYPE_UNKNOWN',
    '/publishes/driver-skill/type',
  ],
  [
    'an opaque contract with an artifact',
    () => {
      const d = pif();
      d.publishes['driver-skill'].type = 'opaque';
      return d;
    },
    'interface',
    'ARTIFACT_FOR_OPAQUE',
    '/publishes/driver-skill/artifact',
  ],
  [
    'a measured contract with no artifact',
    () => {
      const d = pif();
      d.publishes['driver-skill'].artifact = null;
      return d;
    },
    'interface',
    'ARTIFACT_MISSING',
    '/publishes/driver-skill/artifact',
  ],
  [
    'consuming a project rather than a contract',
    () => {
      const d = pif();
      d.consumes[0].contract = 'forge';
      return d;
    },
    'interface',
    'SCHEMA_VIOLATION',
    '/consumes/0/contract',
  ],
  [
    'a consumption with no builtAgainst',
    () => {
      const d = pif();
      delete d.consumes[0].builtAgainst;
      return d;
    },
    'interface',
    'SCHEMA_VIOLATION',
    '/consumes/0/builtAgainst',
  ],
  [
    'a version other than 1',
    () => ({ ...pif(), version: 2 }),
    'interface',
    'VERSION_UNSUPPORTED',
    '/version',
  ],
];

describe('every planted shape is refused by the emitted schema and by name on the write path', () => {
  it.each(plants)('%s', (_name, build, kind, code, path) => {
    const doc = build();
    expect(emittedAccepts(clone(doc))).toBe(false);
    const refusals =
      kind === 'interface'
        ? interfaceRefusals(doc)
        : kind === 'ecosystem'
          ? ecosystemRefusals(doc)
          : (() => {
              const parsed = parseVersionedDocument(membershipDocumentSchema, doc, 'membership');
              return parsed.ok ? [] : parsed.refusals;
            })();
    expect(refusals).toContainEqual(expect.objectContaining({ code, path }));
  });
});
