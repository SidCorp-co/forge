/**
 * The `forge_project_pm` action vocabulary, in a module of its own.
 *
 * It lived in `forge-project-pm.ts` while the only other reader was
 * `mcp/server.ts`, which imports the dispatcher anyway. `project-authz.ts`
 * needs it too — the PM refusal names the actions a caller CAN reach as the
 * complement of the device-only pair — and importing it from there would
 * close a real ESM cycle over top-level `const` init.
 */

// cm:edge contract -> packages/core/src/mcp/tools/project-authz.ts — `assertPmActor`'s refusal is the complement of this list minus `dispatch`/`write_decision`; adding an action here without deciding which side it is on makes the refusal advertise it as reachable
export const PM_ACTIONS = [
  'snapshot',
  'graph',
  'runner_load',
  'dispatch',
  'set_dependency',
  'write_decision',
] as const;
