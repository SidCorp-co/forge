// What each `forge_design` action needs its caller to hold (REQ-12 BC-20, ISS-824), enforced by
// the door before the tool's handler runs.

import type { DESIGN_TOOL_ACTIONS } from '@forge/contracts/mcp-product';
import { byRule, onArg } from '../permissions/index.js';

// each action takes what its REST twin under /api/projects/:id/{workflows,suggestions,mockups}
// declares, on the projectId every call sends (the input requires it), so the door checks it before
// the handler as the route's requiresOnParam does. The rest are declared by the rule that decides
// them, with no floor, since a floor would answer before their named refusals: design_decide (the
// approver rule), suggestion_accept (the gate per kind), suggestion_reject (its SUGGESTION_REFUSED
// permission refusal), suggestion_revise (its producer or suggestions.approve)
const READ = onArg('project.read');
const WRITE = onArg('project.write');
const DESIGN = onArg('workflow-designs.write');
export const DESIGN_PERMISSION = {
  byAction: {
    design_list: READ,
    design_get: READ,
    design_create: DESIGN,
    design_revise: DESIGN,
    design_propose: DESIGN,
    design_withdraw: DESIGN,
    suggestion_list: READ,
    suggestion_create: WRITE,
    suggestion_withdraw: WRITE,
    mockup_list: READ,
    mockup_get: READ,
    mockup_comments: READ,
    mockup_comment: WRITE,
    mockup_propose: WRITE,
    mockup_accept: WRITE,
    mockup_return: WRITE,
    mockup_withdraw: WRITE,
    design_decide: byRule(
      'workflows/design-service.ts:approverRefusalFor',
      "the design's approver rule decides who approves or returns a proposed revision",
    ),
    suggestion_accept: byRule(
      'suggestions/accept-gate.ts:acceptGateOf',
      "the suggestion's kind decides: suggestions.approve, or the person a breakdown waits on",
    ),
    suggestion_reject: byRule(
      'suggestions/service.ts:rejectSuggestion',
      'suggestions.approve, refused by name in the SUGGESTION_REFUSED envelope',
    ),
    suggestion_revise: byRule(
      'suggestions/propose.ts:reviseSuggestion',
      "the suggestion's producer (project.write), or a holder of suggestions.approve",
    ),
  } satisfies Partial<Record<(typeof DESIGN_TOOL_ACTIONS)[number], unknown>>,
} as const;
