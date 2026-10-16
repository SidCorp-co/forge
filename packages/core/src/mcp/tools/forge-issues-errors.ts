/**
 * `forge_issues` errors, as the MCP caller reads them.
 *
 * Its own module because the mapper is the tool's public contract with an agent
 * that cannot see a status code: every arm has to say what was wrong and what
 * shape would be right, so it grows with the surface rather than with the
 * dispatcher beside it.
 */

import { BodyInvalidError } from '../../body/errors.js';
import { AttachmentError } from '../../issues/attachment-service.js';
import { IssueCreateError } from '../../issues/create-service.js';
import { IssueDependencyError } from '../../issues/dependency-service.js';
import { LabelResolutionError, PrimaryModuleError } from '../../issues/label-service.js';
import {
  IssueUpdateNotFound,
  LandingShapeMarkStands,
  SessionContextDropsUnreadKeys,
  SessionContextExpectMismatch,
} from '../../issues/update-service.js';

/** A `relations` entry the graph refused, in the words of the issue the update names. */
function relationRefusal(err: IssueDependencyError): Error {
  switch (err.code) {
    case 'SELF_DEP':
      return new Error(
        'BAD_REQUEST: SELF_DEP: a relation names the issue itself; `dependsOnId` or `blocksId` names another issue of this project',
      );
    case 'NOT_FOUND':
      return new Error(
        `NOT_FOUND: RELATION_TARGET_NOT_FOUND: ${err.detail ?? 'a relation names an issue that does not exist'}; \`dependsOnId\` or \`blocksId\` names an issue of this project`,
      );
    case 'CROSS_PROJECT':
      return new Error(
        "BAD_REQUEST: CROSS_PROJECT: a relation names an issue of another project; both sides of a relation belong to this issue's project",
      );
    case 'CYCLE_DETECTED':
      return new Error('CYCLE_DETECTED: this blocks relation would close a loop of blocks edges');
    case 'CYCLE_DEPTH_EXCEEDED':
      return new Error(
        'CYCLE_DEPTH_EXCEEDED: the blocks graph behind this relation is deeper than a loop can be checked for',
      );
    case 'HOLD_NEEDS_BLOCKS':
      return new Error(`BAD_REQUEST: ${err.message}`);
    default:
      return new Error(err.message);
  }
}

export function toMcpIssueError(err: unknown): unknown {
  if (err instanceof BodyInvalidError) return new Error(`BAD_REQUEST: ${err.code}: ${err.message}`);
  if (err instanceof PrimaryModuleError) {
    return new Error(`BAD_REQUEST: ${err.code}: ${err.message}`);
  }
  if (err instanceof LabelResolutionError) {
    return new Error(
      `BAD_REQUEST: one or more labels do not exist in this project (no auto-create): ${err.missing.join(', ')}`,
    );
  }
  if (err instanceof AttachmentError) return new Error(`${err.code}: ${err.message}`);
  if (err instanceof SessionContextDropsUnreadKeys) {
    return new Error(
      `SESSION_CONTEXT_DROPS_UNREAD_KEYS: this write replaces \`sessionContext\` whole and would remove ${err.dropped.join(', ')}, which it never read. ` +
        'Read the field, add your key to what is there, and send it back complete — or send ' +
        '`expect: { sessionContext: <what you read> }` to say the removal is deliberate.',
    );
  }
  if (err instanceof LandingShapeMarkStands) return new Error(`${err.code}: ${err.message}`);
  if (err instanceof IssueDependencyError) return relationRefusal(err);
  if (err instanceof IssueUpdateNotFound) {
    return new Error('NOT_FOUND: the issue was gone by the time this update reached it');
  }
  if (err instanceof SessionContextExpectMismatch) {
    return new Error(
      'SESSION_CONTEXT_MISMATCH: `sessionContext` no longer holds the value this write expected — ' +
        'another writer moved it. It now holds ' +
        `${JSON.stringify(err.current)}. Decide whether your claim still stands, then send the write again with the new \`expect\`.`,
    );
  }
  if (err instanceof IssueCreateError) {
    if (err.code === 'INVALID_DETECTOR_KEY') {
      return new Error(
        `BAD_REQUEST: data.detectorKey must be lowercase slash-separated slugs, max 120 chars (got '${err.value}')`,
      );
    }
    return new Error(
      `BAD_REQUEST: status at create must be 'open', 'on_hold', or 'draft' (got '${err.value}'); use the transition action for other statuses`,
    );
  }
  return err;
}
