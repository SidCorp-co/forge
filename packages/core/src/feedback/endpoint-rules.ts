/**
 * The routes and tools a project serves, as an `endpoint` target names them (ISS-279): each element of
 * the current version of an openapi contract (`METHOD /path`) or an mcp-tools contract (a tool, never
 * one of its input properties) that the project itself provides. A name outside that set is refused
 * by name, so an endpoint is never free text the way a screen is.
 */

import {
  FEEDBACK_ENDPOINT_CONTRACT_TYPES,
  type FeedbackEndpointContractType,
  type FeedbackEndpointView,
  type FeedbackRefusal,
} from '@forge/contracts/feedback';
import type { ContractVersionFact } from '../lib/contract-versions.js';

const isEndpointType = (type: string): type is FeedbackEndpointContractType =>
  (FEEDBACK_ENDPOINT_CONTRACT_TYPES as readonly string[]).includes(type);

// a tool's input property is indexed as `<tool>/properties/<name>` (contract/elements.ts); it is
// part of a tool, not a tool
const isServedElement = (type: FeedbackEndpointContractType, element: string) =>
  type === 'openapi' || !element.includes('/properties/');

/** The served set, from the current versions a project provides, ordered by key. */
export function servedFrom(current: readonly ContractVersionFact[]): FeedbackEndpointView[] {
  return current
    .flatMap((v) => {
      const type = v.contractType;
      if (!isEndpointType(type)) return [];
      return (v.elements ?? [])
        .filter((element) => isServedElement(type, element))
        .map((element) => ({
          key: `${v.contractSlug}:${element}`,
          contract: v.contractSlug,
          version: v.version,
          type,
          element,
        }));
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const SHOWN = 20;

function listed(served: readonly FeedbackEndpointView[]): string {
  const shown = served.slice(0, SHOWN).map((s) => s.key);
  const more = served.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more (GET …/feedback/endpoints lists them)` : ''}`;
}

/** The one served route or tool `ref` names, bare or as `<contract>:<element>`, or the refusal naming why not. */
export function endpointIn(
  served: readonly FeedbackEndpointView[],
  ref: string,
  path: string,
): FeedbackEndpointView | FeedbackRefusal {
  const name = ref.trim();
  if (served.length === 0) {
    return {
      code: 'FEEDBACK_TARGET_UNKNOWN',
      path,
      detail: `"${name}" names no route or tool of this project: it provides no openapi or mcp-tools contract with an approved version. A project serves what its interface provides (PUT /api/projects/:id/interface, then record and approve the contract's version); until it does, name what you saw as a screen.`,
    };
  }
  const exact = served.find((s) => s.key === name);
  if (exact) return exact;
  const matches = served.filter((s) => s.element === name);
  const [only] = matches;
  if (only && matches.length === 1) return only;
  if (matches.length > 1) {
    return {
      code: 'FEEDBACK_TARGET_NOT_ONE',
      path,
      detail: `"${name}" is served by ${matches.length} contracts of this project (${matches.map((s) => s.key).join(', ')}); name the one you mean as <contract>:<element>.`,
    };
  }
  return {
    code: 'FEEDBACK_TARGET_UNKNOWN',
    path,
    detail: `"${name}" names no route or tool this project serves. It serves ${listed(served)}; name one as listed, or by its element alone where one contract serves it.`,
  };
}
