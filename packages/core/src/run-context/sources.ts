import { createHash } from 'node:crypto';
import {
  RUN_CONTEXT_DIGEST_PREFIX,
  type RunContextSource,
  type RunContextSourceKind,
} from '@forge/contracts/run-context';

/** A knowledge entry or hit as a read returns it; only these fields are read. */
export interface KnowledgeFound {
  slug: string;
  kind?: string;
  updatedAt?: Date | string | null;
  body?: string;
}

/** A memory hit as a search returns it; only these fields are read. */
export interface MemoryFound {
  id: string;
  asOf?: Date | string | null;
  text?: string;
}

/** What one read returned, as the recorder takes it. */
export interface Found {
  knowledge?: readonly KnowledgeFound[];
  memory?: readonly MemoryFound[];
}

/** `sha256:<16 hex>` of the text a run was given: the revision where the read carried no timestamp. */
export function digestOf(text: string): string {
  return `${RUN_CONTEXT_DIGEST_PREFIX}${createHash('sha256').update(text).digest('hex').slice(0, 16)}`;
}

function stamp(at: Date | string | null | undefined): string | null {
  if (at instanceof Date) return Number.isNaN(at.getTime()) ? null : at.toISOString();
  return typeof at === 'string' && at.length > 0 ? at : null;
}

/** A knowledge entry is a rule or a lesson by its kind, and knowledge otherwise. */
function knowledgeKind(kind: string | undefined): RunContextSourceKind {
  return kind === 'rule' || kind === 'lesson' ? kind : 'knowledge';
}

/** Each source a read returned, with the version it was in. */
export function sourcesOf(found: Found): RunContextSource[] {
  const knowledge = (found.knowledge ?? []).map((k) => ({
    kind: knowledgeKind(k.kind),
    ref: k.slug,
    revision: stamp(k.updatedAt) ?? (k.body === undefined ? null : digestOf(k.body)),
  }));
  const memory = (found.memory ?? []).map((m) => ({
    kind: 'memory' as const,
    ref: m.id,
    revision: stamp(m.asOf) ?? (m.text === undefined ? null : digestOf(m.text)),
  }));
  return [...knowledge, ...memory];
}
