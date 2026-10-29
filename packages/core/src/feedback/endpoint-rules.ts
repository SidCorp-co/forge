/**
 * The routes, tools and commands a project serves, as an `endpoint` target names them (ISS-279,
 * ISS-594): each element of the current version of an openapi contract (`METHOD /path`), an mcp-tools
 * contract (a tool, never one of its input properties) or a cli contract (`<program> <command>`, never
 * one of its options) that the project itself provides. A name outside that set is refused by name,
 * so an endpoint is never free text the way a screen is.
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

// a tool's input property is indexed as `<tool>/properties/<name>` and a command's flag as
// `<command>/options/<flag>` (contract/elements.ts); each is part of what it sits under, not served
// on its own
const PART_OF: Record<FeedbackEndpointContractType, string | null> = {
  openapi: null,
  'mcp-tools': '/properties/',
  cli: '/options/',
};

const isServedElement = (type: FeedbackEndpointContractType, element: string) => {
  const part = PART_OF[type];
  return part === null || !element.includes(part);
};

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

const SERVING_TYPES = `${FEEDBACK_ENDPOINT_CONTRACT_TYPES.slice(0, -1).join(', ')} or ${FEEDBACK_ENDPOINT_CONTRACT_TYPES.at(-1)}`;

function listed(served: readonly FeedbackEndpointView[]): string {
  const shown = served.slice(0, SHOWN).map((s) => s.key);
  const more = served.length - shown.length;
  return `${shown.join(', ')}${more > 0 ? ` and ${more} more (GET …/feedback/endpoints lists them)` : ''}`;
}

/** The one served route, tool or command `ref` names, bare or as `<contract>:<element>`, or the refusal naming why not. */
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
      detail: `"${name}" names no route, tool or command of this project: it provides no ${SERVING_TYPES} contract with an approved version. A project serves what its interface provides (PUT /api/projects/:id/interface, then record and approve the contract's version); until it does, name what you saw as a screen.`,
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
    detail: `"${name}" names no route, tool or command this project serves. It serves ${listed(served)}; name one as listed, or by its element alone where one contract serves it.`,
  };
}
