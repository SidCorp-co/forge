// The REST writes that do another door's act (ISS-1251), an MCP action's or a REST write's: one
// capability, one card, so a REST twin carries no card of its own and a call through either counts on
// the one door. Each pair
// was read from the action's handler calling what the route calls (builder H's survey). The door
// catalog folds each twin into its action and refuses a pair either side of which this build does
// not serve, or which carries two cards (`door-catalog.ts:twinned`).

export const REST_TWINS: Readonly<Record<string, readonly string[]>> = {
  'feedback.submit': ['POST /api/forge/feedback'],
  'feedback.verify': ['POST /api/forge/feedback/:key/verify'],
  'feedback.reopen': ['POST /api/forge/feedback/:key/reopen'],
  'feedback.reply': ['POST /api/forge/feedback/:key/reply'],
  'feedback.door': ['POST /api/forge/feedback/doors'],
  // (the batch's contracts:generate); the catalog refuses a twin the contract does not list
  'requirements.create': ['POST /api/projects/:id/requirements'],
  'requirements.revise': [
    'POST /api/projects/:id/requirements/:req/revisions',
    'PUT /api/projects/:id/requirements/:req/revisions/:n',
  ],
  'requirements.propose': ['POST /api/projects/:id/requirements/:req/revisions/:n/propose'],
  'requirements.withdraw': ['POST /api/projects/:id/requirements/:req/revisions/:n/withdraw'],
  'requirements.link_design': ['POST /api/projects/:id/requirements/:req/workflows'],
  'requirements.unlink_design': [
    'DELETE /api/projects/:id/requirements/:req/workflows/:workflowId',
  ],
  'requirements.trace_criterion': ['PUT /api/projects/:id/requirements/:req/criteria/:code/steps'],
  'questions.answer': ['POST /api/questions/:id/answer'],
  'project_feedback.submit': ['POST /api/projects/:id/feedback'],
  'project_feedback.clarify': ['POST /api/projects/:id/feedback/:fb/clarification'],
  'project_feedback.attach': ['POST /api/projects/:id/feedback/:fb/attachments'],
  'design.design_create': ['POST /api/projects/:id/workflows'],
  'design.design_revise': ['PUT /api/projects/:id/workflows/:workflow'],
  'design.design_propose': ['POST /api/projects/:id/workflows/:workflow/design/propose'],
  'design.design_decide': ['POST /api/projects/:id/workflows/:workflow/design/decision'],
  'design.design_withdraw': ['POST /api/projects/:id/workflows/:workflow/design/withdraw'],
  'design.suggestion_create': ['POST /api/projects/:id/suggestions'],
  'design.suggestion_accept': ['POST /api/projects/:id/suggestions/:sid/accept'],
  'design.suggestion_reject': ['POST /api/projects/:id/suggestions/:sid/reject'],
  'design.suggestion_revise': ['POST /api/projects/:id/suggestions/:sid/revise'],
  'design.suggestion_withdraw': ['POST /api/projects/:id/suggestions/:sid/withdraw'],
  'design.mockup_propose': ['POST /api/projects/:id/mockups'],
  'design.mockup_accept': ['POST /api/projects/:id/mockups/:mk/accept'],
  'design.mockup_return': ['POST /api/projects/:id/mockups/:mk/return'],
  'design.mockup_withdraw': ['POST /api/projects/:id/mockups/:mk/withdraw'],
  'design.mockup_comment': ['POST /api/projects/:id/mockups/:mk/comments'],
  'releases.decide': [
    'POST /api/projects/:projectId/releases/:version/approval',
    'POST /api/projects/:projectId/release-batches/:runId/approvals/:approvalId/decision',
  ],
  'releases.name': ['PUT /api/projects/:projectId/releases/:version/naming'],
  'projects.create': ['POST /api/projects'],
  'config.write': ['PUT /api/projects/:id/config'],
  'config.gates_write': ['PUT /api/projects/:id/gates'],
  'bindings.write': ['PUT /api/projects/:id/bindings/:bindingId'],
  'ecosystem.interface_write': ['PUT /api/projects/:id/interface'],
  'ecosystem.link_create': ['POST /api/projects/:id/links'],
  'ecosystem.link_update': ['PUT /api/projects/:id/links/:link'],
  'ecosystem.builder_run_create': ['POST /api/projects/:id/builder-runs'],
  'ecosystem.builder_run_update': ['PUT /api/projects/:id/builder-runs/:run'],
  'ecosystem.builder_run_supersede': [
    'POST /api/projects/:id/builder-runs/:run/supersede',
    'POST /api/ecosystems/:id/builder-runs/:run/supersede',
  ],
  'ecosystem.context': ['POST /api/projects/:id/contract-context'],
  'ecosystem.contract_version_publish': ['POST /api/projects/:id/contracts/:contract/versions'],
  'ecosystem.contract_version_decide': [
    'POST /api/projects/:id/contracts/:contract/versions/:version/decision',
  ],
  'channel.draft': ['POST /api/projects/:id/channel/drafts'],
  'channel.edit': ['PUT /api/projects/:id/channel/documents/:doc'],
  'channel.submit': ['POST /api/projects/:id/channel/documents/:doc/submit'],
  'channel.supersede': ['POST /api/projects/:id/channel/documents/:doc/supersede'],
  'channel.withdraw': ['POST /api/projects/:id/channel/documents/:doc/withdraw'],
  'channel.hold': ['POST /api/projects/:id/channel/threads/:number/hold'],
  'channel.release': ['POST /api/projects/:id/channel/threads/:number/release'],
  'bot.open': ['POST /api/conversations'],
  'bot.send': ['POST /api/conversations/:id/messages'],
  'bot.cancel': ['POST /api/conversations/:id/stop'],
  // an item about Forge waits on its confirm by the same body as a project's item does
  'POST /api/projects/:id/feedback/:fb/confirm-wait': [
    'POST /api/forge/feedback/:key/confirm-wait',
  ],
};
