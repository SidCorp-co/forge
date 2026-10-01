import type { ChannelDocument } from '../channel-schema.js';
import type { ChangeLevel, MeasuredClassification } from './diff.js';
import type { ContractExample, ContractIndex } from './elements.js';

export interface MeasuredVersion {
  classification: MeasuredClassification;
  changes: readonly { element: string; level: ChangeLevel }[];
}

export interface VersionFacts {
  elements: ReadonlySet<string> | null;
  previous: string | null;
}

export interface ContractFacts {
  measured: ReadonlyMap<string, MeasuredVersion>;
  versions: ReadonlyMap<string, VersionFacts>;
  latest: ReadonlyMap<string, string>;
  indexes: ReadonlyMap<string, ContractIndex>;
}

export const EMPTY_FACTS: ContractFacts = {
  measured: new Map(),
  versions: new Map(),
  latest: new Map(),
  indexes: new Map(),
};

export const citedKey = (ref: string, version: string) => `${ref}@${version}`;

export interface Citation {
  ref: string;
  version: string | null;
  versionPath: string | null;
  withPrevious: boolean;
  elements: { element: string; path: string }[];
  examples: { example: ContractExample; path: string }[];
}

type Doc = ChannelDocument;

function changeNotice(d: Extract<Doc, { type: 'change-notice' }>): Citation[] {
  const b = d.body;
  return [
    {
      ref: b.contract,
      version: b.contractVersion,
      versionPath: null,
      withPrevious: true,
      elements: [
        ...b.changes.map((c, i) => ({ element: c.element, path: `/body/changes/${i}/element` })),
        ...(b.deprecation?.elements ?? []).map((e, i) => ({
          element: e,
          path: `/body/deprecation/elements/${i}`,
        })),
      ],
      examples: (b.examples ?? []).map((example, i) => ({ example, path: `/body/examples/${i}` })),
    },
  ];
}

// cm:why a change request proposes behaviour the contract does not have yet and a decision may plan a version not recorded yet, so neither is held to a recorded version's elements
export function citationsOf(d: Doc, documents: ReadonlyMap<string, Doc>): Citation[] {
  if (d.type === 'change-notice') return changeNotice(d);
  if (d.type === 'rfi') {
    const refs = d.body.references.map((r, i) => ({
      ref: r.contract,
      version: r.contractVersion ?? null,
      versionPath: r.contractVersion ? `/body/references/${i}/contractVersion` : null,
      withPrevious: false,
      elements: [{ element: r.element, path: `/body/references/${i}/element` }],
      examples: [] as Citation['examples'],
    }));
    (d.body.examples ?? []).forEach((example, i) => {
      const home = refs.find((r) => r.elements[0]?.element === example.element) ?? refs[0];
      home?.examples.push({ example, path: `/body/examples/${i}` });
    });
    return refs;
  }
  if (d.type === 'acknowledgement' && d.inReplyTo) {
    const parent = documents.get(d.inReplyTo);
    if (parent?.type !== 'change-notice') return [];
    return [
      {
        ref: parent.body.contract,
        version: parent.body.contractVersion,
        versionPath: null,
        withPrevious: true,
        elements: (d.body.blockedOn ?? []).map((b, i) => ({
          element: b.element,
          path: `/body/blockedOn/${i}/element`,
        })),
        examples: [],
      },
    ];
  }
  return [];
}
