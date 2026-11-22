import type { EcosystemRefusalCode } from '@forge/contracts/ecosystem';
import { FEEDBACK_KINDS } from '@forge/contracts/feedback-terms';
import { refuser } from '../lib/refusal.js';
import type { ApiRefusal } from '../project-config/index.js';

export type {
  ChannelRefusalCode,
  EcosystemRefusalCode,
  EcosystemToolRefusalCode,
  LinkRefusalCode,
} from '@forge/contracts/ecosystem';

export const refuseEcosystem = refuser<EcosystemRefusalCode>('ECOSYSTEM_REFUSED');

export interface EcosystemRefusal {
  code: EcosystemRefusalCode | ApiRefusal['code'];
  path: string;
  detail: string;
}

export type Checked<T> = { ok: true; value: T } | { ok: false; refusals: EcosystemRefusal[] };

const CONTRACT_TYPE_PATH = /^\/publishes\/[^/]+\/type$/;

export function renameParseRefusals(refusals: readonly ApiRefusal[]): EcosystemRefusal[] {
  return refusals.map((r) =>
    r.code === 'SCHEMA_VIOLATION' && CONTRACT_TYPE_PATH.test(r.path)
      ? {
          code: 'CONTRACT_TYPE_UNKNOWN',
          path: r.path,
          detail: `${r.detail}; a contract type is one of the closed vocabulary, because it decides which differ measures it.`,
        }
      : r,
  );
}

export function renameDocumentParseRefusals(
  refusals: readonly ApiRefusal[],
  raw: unknown,
): EcosystemRefusal[] {
  return refusals.map((r) => {
    if (r.code !== 'SCHEMA_VIOLATION') return r;
    if (r.path === '/type') {
      return {
        code: 'DOCUMENT_TYPE_UNKNOWN',
        path: r.path,
        detail: `${r.detail}; the channel carries five types of document and nothing else, so there is no free message.`,
      };
    }
    const type = contractUnsetAt(raw, r.path);
    return type
      ? { code: 'DOCUMENT_CONTRACT_MISSING', path: r.path, detail: noContract(type, raw) }
      : r;
  });
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const unset = (v: unknown) =>
  v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const REFERENCE_CONTRACT = /^\/body\/references\/(\d+)\/contract$/;

// FB-818 (ISS-1409): an agent with a defect in another project's part, outside every contract, was
// refused only by the schema here and read it as "invent a contract". The schema stays strict; a
// change request or an RFI that names no contract is refused by name, pointing at the handoff door.
function contractUnsetAt(raw: unknown, path: string): 'change-request' | 'rfi' | null {
  if (!isObject(raw) || !isObject(raw.body)) return null;
  const { body } = raw;
  if (raw.type === 'change-request') {
    return path === '/body/contract' && unset(body.contract) ? 'change-request' : null;
  }
  if (raw.type !== 'rfi') return null;
  const refs = body.references;
  if (path === '/body/references') {
    return unset(refs) || (Array.isArray(refs) && refs.length === 0) ? 'rfi' : null;
  }
  const at = REFERENCE_CONTRACT.exec(path)?.[1];
  const ref = at !== undefined && Array.isArray(refs) ? refs[Number(at)] : undefined;
  return isObject(ref) && unset(ref.contract) ? 'rfi' : null;
}

// the kinds a reporter files under; contract_change is core's own, filed for a breaking version
export const HANDOFF_KINDS = FEEDBACK_KINDS.filter((k) => k !== 'contract_change')
  .map((k) => `"${k}"`)
  .join(' | ');

function noContract(type: 'change-request' | 'rfi', raw: unknown): string {
  const from = isObject(raw) && typeof raw.from === 'string' ? raw.from : ':id';
  const asks =
    type === 'change-request'
      ? 'a change request asks for a change to a contract the two projects share: body.contract names it as "<provider-slug>/<contract-slug>"'
      : 'an RFI asks about a contract the two projects share: body.references lists each { contract, element } it asks about, contract as "<provider-slug>/<contract-slug>"';
  return (
    `${asks}. A finding in another project's part outside any contract (a defect, shared test infrastructure, ops) ` +
    `goes as a handoff, never under an invented contract: POST /api/projects/${from}/channel/handoffs ` +
    `{ "to": <its project uuid>, "item": <your issue or feedback key>, "kind": ${HANDOFF_KINDS}, "title", "whereSeen" } ` +
    "files it at that project's intake as feedback naming your item."
  );
}

export function renameHoldParseRefusals(refusals: readonly ApiRefusal[]): EcosystemRefusal[] {
  return refusals.map((r) =>
    r.code === 'SCHEMA_VIOLATION' && r.path === '/reason'
      ? {
          code: 'HOLD_WITHOUT_REASON',
          path: r.path,
          detail: 'a hold says why, in 1 to 1000 characters, and both sides read it.',
        }
      : r,
  );
}
