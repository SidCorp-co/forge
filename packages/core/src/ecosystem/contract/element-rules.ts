import type { Tx } from '../../db/client.js';
import type { ChannelDocument } from '../channel-schema.js';
import type { EcosystemRefusal } from '../refusals.js';
import {
  type Citation,
  type ContractFacts,
  citationsOf,
  citedKey,
  type MeasuredVersion,
  type VersionFacts,
} from './citations.js';
import { type ContractIndex, exampleProblem, indexContract, isIndexed } from './elements.js';
import { parseArtifact } from './measure.js';
import { readArtifact, versionsOf } from './store.js';

function resolved(c: Citation, f: ContractFacts): { version: string; facts: VersionFacts } | null {
  const version = c.version ?? f.latest.get(c.ref) ?? null;
  const facts = version ? f.versions.get(citedKey(c.ref, version)) : undefined;
  return version && facts ? { version, facts } : null;
}

function citationRefusals(c: Citation, f: ContractFacts): EcosystemRefusal[] {
  const hit = resolved(c, f);
  if (!hit) {
    if (!c.versionPath) return [];
    return [
      {
        code: 'VERSION_UNKNOWN',
        path: c.versionPath,
        detail: `${c.ref} has no recorded version "${c.version}"; a document cites a version core has recorded.`,
      },
    ];
  }
  const { version, facts } = hit;
  if (!facts.elements) return [];
  const prior =
    c.withPrevious && facts.previous ? f.versions.get(citedKey(c.ref, facts.previous)) : undefined;
  const known = new Set([...facts.elements, ...(prior?.elements ?? [])]);
  const where = `${c.ref}@${version}${prior ? ` or the version before it, ${facts.previous}` : ''}`;
  const out: EcosystemRefusal[] = c.elements
    .filter((e) => !known.has(e.element))
    .map((e) => ({
      code: 'ELEMENT_NOT_IN_CONTRACT',
      path: e.path,
      detail: `"${e.element}" is not an element of ${where}.`,
    }));
  for (const { example, path } of c.examples) {
    const home = facts.elements.has(example.element) || !facts.previous ? version : facts.previous;
    const index = f.indexes.get(citedKey(c.ref, home));
    const problem = index
      ? exampleProblem(index, example)
      : {
          code: 'EXAMPLE_NOT_IN_CONTRACT' as const,
          detail: `the artifact of ${c.ref}@${home} could not be read, so the example cannot be checked`,
        };
    if (problem)
      out.push({ code: problem.code, path, detail: `${problem.detail} (${c.ref}@${home}).` });
  }
  return out;
}

export function elementRefusals(
  d: ChannelDocument,
  documents: ReadonlyMap<string, ChannelDocument>,
  f: ContractFacts,
): EcosystemRefusal[] {
  return citationsOf(d, documents).flatMap((c) => citationRefusals(c, f));
}

export async function loadContractFacts(
  tx: Tx,
  slugOf: ReadonlyMap<string, string>,
  cites: { doc: ChannelDocument; documents: ReadonlyMap<string, ChannelDocument> } | null,
): Promise<ContractFacts> {
  const rows = await versionsOf(tx, [...slugOf.keys()]);
  const measured = new Map<string, MeasuredVersion>();
  const versions = new Map<string, VersionFacts>();
  const latest = new Map<string, string>();
  const types = new Map<string, { type: string; sha: string | null }>();
  for (const row of rows) {
    const ref = `${slugOf.get(row.providerProjectId)}/${row.contractSlug}`;
    const key = citedKey(ref, row.version);
    if (!latest.has(ref)) latest.set(ref, row.version);
    const { classification, changes } = row.document.diff;
    measured.set(key, {
      classification,
      changes: changes.map((c) => ({
        element: c.element,
        level: c.level,
        kind: c.kind,
        text: c.text,
        check: c.check,
      })),
    });
    versions.set(key, {
      elements: row.elements ? new Set(row.elements) : null,
      previous: row.document.previous ?? null,
      recordedOn: row.recordedAt.toISOString().slice(0, 10),
    });
    types.set(key, { type: row.contractType, sha: row.artifactSha256 });
  }
  const indexes = new Map<string, ContractIndex>();
  const wanted = cites
    ? citationsOf(cites.doc, cites.documents).filter((c) => c.examples.length > 0)
    : [];
  for (const c of wanted) {
    const version = c.version ?? latest.get(c.ref);
    const previous = version ? versions.get(citedKey(c.ref, version))?.previous : null;
    for (const v of [version, previous]) {
      const key = v ? citedKey(c.ref, v) : null;
      const t = key ? types.get(key) : undefined;
      if (!key || !t?.sha || !isIndexed(t.type) || indexes.has(key)) continue;
      const text = await readArtifact(tx, t.sha);
      if (text) indexes.set(key, indexContract(t.type, parseArtifact(t.type, text)));
    }
  }
  return { measured, versions, latest, indexes };
}
