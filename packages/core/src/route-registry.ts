// The one route-mount registry: every module's routes, mounted from its public face, in the order
// Hono matches them. Order is load-bearing: a router's `use('*')` gates every later router mounted
// under the same prefix.

import type { Hono } from 'hono';
import {
  adminAggregateRoutes,
  adminAlertRoutes,
  adminMcpAuditRoutes,
  adminMetricSeriesRoutes,
  adminRoutes,
  adminThresholdRoutes,
  pipelineHealthAdminRoutes,
} from './admin/index.js';
import { agentReportRoutes, feedbackReportsAliasRoutes } from './agent-reports/index.js';
import {
  agentSessionAttachmentRoutes,
  agentSessionProjectReadRoutes,
  agentSessionRoutes,
} from './agent-sessions/index.js';
import { agentRoutes } from './agents/index.js';
import { memoryModelRoutes } from './app-config/memory-model-routes.js';
import { appConfigRoutes } from './app-config/routes.js';
import {
  assistantWeeklyRoutes,
  baDoorRoutes,
  conversationRoutes,
  speakerLinkMeRoutes,
  speakerLinkProjectRoutes,
} from './assistant/index.js';
import {
  authRoutes,
  devForceVerifyRoutes,
  loginRoutes,
  logoutRoutes,
  meRoutes,
  oauthRoutes,
  reauthRoutes,
  refreshRoutes,
  verifyRoutes,
} from './auth/index.js';
import { automationRoutes } from './automation/index.js';
import { chatLogRoutes } from './chat-logs/index.js';
import { commentRoutes, entityCommentRoutes } from './comments/index.js';
import { contentLanguageRoutes } from './content-language/index.js';
import { developmentOverviewRoutes, needsYouRoutes } from './development/index.js';
import {
  deviceAuthRoutes,
  deviceLoginRoutes,
  deviceMcpServerRoutes,
  deviceOrgRoutes,
  deviceOwnerRoutes,
  devicePoolRoutes,
  devicePublicRoutes,
  deviceSkillRoutes,
  deviceSkillStatusRoutes,
  deviceUserRoutes,
  runLedgerRoutes,
} from './devices/index.js';
import { domainTemplateRoutes } from './domain-templates/index.js';
import {
  busRoutes,
  channelProjectRoutes,
  contractRequestRoutes,
  contractRoutes,
  contractStandingRoutes,
  contractWaitRoutes,
  ecosystemProjectRoutes,
  ecosystemRoutes,
  linkProjectRoutes,
  membershipRoutes,
} from './ecosystem/index.js';
import { feedbackRoutes } from './feedback/index.js';
import { deviceGitCredentialRoutes } from './git/index.js';
import { guideRoutes } from './guides/index.js';
import { opsHealthMeRoutes, opsHealthProjectRoutes, publicHealthRoutes } from './health/index.js';
import { improvementMessageRoutes } from './improvement-messages/index.js';
import { installRoutes } from './install/index.js';
import {
  githubCallbackRoutes,
  githubConnectRoutes,
  integrationConnectionsRoutes,
  integrationsRoutes,
  integrationTargetRoutes,
  runnerReleaseRoutes,
} from './integration-door/index.js';
import {
  attachmentRoutes,
  backlogStreamRoutes,
  bodyRoutes,
  issueActivityRoutes,
  issueArchiveRoutes,
  issueAttachmentRoutes,
  issueCriteriaRoutes,
  issueDependencyRoutes,
  issueExtrasRoutes,
  issueMergeRoutes,
  issueProjectRoutes,
  issueRoutes,
  issueStandingRoutes,
  issueSteerRoutes,
  projectActivityRoutes,
  searchRoutes,
  transitionRoutes,
} from './issues/index.js';
import {
  jobEventsListRoutes,
  jobEventsRoutes,
  jobLifecycleDeviceRoutes,
  jobLifecycleUserRoutes,
  jobProjectRoutes,
  jobRoutes,
  jobTestingSecretsRoutes,
} from './jobs/index.js';
import { knowledgeIngestRoutes, knowledgeRoutes } from './knowledge/index.js';
import { knowledgeEdgeRoutes } from './knowledge-edges/index.js';
import { labelProjectRoutes, labelRoutes, moduleDiagramRoutes } from './labels/index.js';
import { isEnabled } from './lib/feature-flags.js';
import { deviceMasterRoutes, masterStandingRoutes } from './masters/index.js';
import { mcpHandler, mcpRequestClass } from './mcp/index.js';
import { meAttentionRoutes, mePulseRoutes, meRecentChangesRoutes } from './me/index.js';
import {
  memoryListRoutes,
  memoryMineRoutes,
  memorySearchRoutes,
  memoryWriteRoutes,
} from './memory/index.js';
import { projectMetricsRoutes } from './metrics/index.js';
import type { RequestIdVars } from './middleware/request-id.js';
import { requirePat } from './middleware/require-pat.js';
import { mockupRoutes } from './mockups/index.js';
import { notificationRoutes } from './notifications/index.js';
import { onboardingRoutes } from './onboarding/index.js';
import { orgInvitationRoutes, orgRoutes, sshKeyRoutes } from './orgs/index.js';
import { patRoutes } from './pat/routes.js';
import {
  phaseRoutes,
  pipelineAnalyticsRoutes,
  pipelineRegistryRoutes,
  pipelineRunProjectRoutes,
  pipelineRunReadRoutes,
  pipelineRunRoutes,
  projectCostAnalyticsRoutes,
  stepHandoffRoutes,
} from './pipeline/index.js';
import { pmReadRoutes, pmRoutes } from './pm/index.js';
import { routes as preferenceRoutes } from './preferences/index.js';
import {
  environmentStateRoutes,
  projectConfigRoutes,
  projectConfigSchemaRoutes,
} from './project-config/index.js';
import {
  collaboratorsMeRoutes,
  gitCredentialRoutes,
  invitationRoutes,
  masterCharterRoutes,
  memberRoutes,
  projectHealthRoutes,
  projectRoutes,
} from './projects/index.js';
import { promptRoutes } from './prompt/index.js';
import { questionnaireRoutes } from './questionnaires/index.js';
import { questionRoutes } from './questions/index.js';
import { releaseBatchRoutes } from './release-batch/index.js';
import { requirementRoutes } from './requirements/index.js';
import { mcpMessageBody, mcpNoBody, rootRoutes } from './root-routes.js';
import { runnerRoutes } from './runners/index.js';
import { runStandingRoutes } from './runs/index.js';
import { scheduleRoutes } from './schedules/index.js';
import { skillFactsRoutes } from './skill-facts/index.js';
import {
  divergenceCharterRoutes,
  reconcileRoutes,
  skillActivityRoutes,
  skillCrudRoutes,
  skillPinRoutes,
  skillRegisterRoutes,
  skillSmokeVerifyRoutes,
  skillStudioRoutes,
  skillSyncRoutes,
} from './skills/index.js';
import { suggestionRoutes } from './suggestions/index.js';
import { taskIssueRoutes, taskRoutes } from './tasks/index.js';
import { updatePacketRoutes } from './update-packets/index.js';
import { uploadRoutes } from './uploads/index.js';
import { usageRecordRoutes } from './usage-records/index.js';
import { webhookInboundRoutes } from './webhooks/index.js';
import { workflowRoutes, workflowTemplateCatalogueRoutes } from './workflows/index.js';

export function mountRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  for (const at of ['/', '/api']) app.route(at, publicHealthRoutes);

  app.use('/mcp', mcpRequestClass(), requirePat());
  app.post('/mcp', mcpMessageBody, mcpHandler);
  app.on(['GET', 'DELETE'], '/mcp', mcpNoBody, mcpHandler);

  for (const at of ['/', '/api']) app.route(at, installRoutes);
  for (const at of ['/', '/api']) app.route(at, guideRoutes);

  app.route('/', rootRoutes);

  app.route('/api/auth', authRoutes);
  app.route('/api/auth', loginRoutes);
  app.route('/api/auth', refreshRoutes);
  app.route('/api/auth', verifyRoutes);
  app.route('/api/auth', devForceVerifyRoutes);
  app.route('/api/auth', meRoutes);
  app.route('/api/auth', preferenceRoutes);
  app.route('/api/auth', logoutRoutes);
  app.route('/api/auth', reauthRoutes);
  app.route('/api', patRoutes);
  app.route('/api/auth', oauthRoutes);
  app.route('/api/projects', projectHealthRoutes);
  app.route('/api/projects', opsHealthProjectRoutes);
  app.route('/api/me', opsHealthMeRoutes);
  app.route('/api/me', collaboratorsMeRoutes);
  app.route('/api/projects', projectMetricsRoutes);
  app.route('/api/projects', gitCredentialRoutes);
  app.route('/api/projects', runLedgerRoutes);
  app.route('/api/projects', masterCharterRoutes);

  app.route('/api', projectConfigSchemaRoutes);
  app.route('/api/workflow-templates', workflowTemplateCatalogueRoutes);
  app.route('/api/projects', projectConfigRoutes);
  app.route('/api/projects', environmentStateRoutes);
  app.route('/api/projects', workflowRoutes);
  app.route('/api/projects', requirementRoutes);
  app.route('/api/projects', suggestionRoutes);
  app.route('/api/projects', feedbackRoutes);
  app.route('/api/projects', mockupRoutes);
  app.route('/api/projects', baDoorRoutes);
  app.route('/api/projects', onboardingRoutes);
  app.route('/api/projects', questionnaireRoutes);
  app.route('/api/projects', contentLanguageRoutes);
  app.route('/api/projects', entityCommentRoutes);
  app.route('/api/projects', automationRoutes);

  app.route('/api/projects', ecosystemProjectRoutes);
  app.route('/api/projects', channelProjectRoutes);
  app.route('/api/projects', contractRoutes);
  app.route('/api/projects', linkProjectRoutes);
  app.route('/api/projects', contractRequestRoutes);
  app.route('/api/projects', contractStandingRoutes);
  app.route('/api/ecosystems', ecosystemRoutes);
  app.route('/api/ecosystems', busRoutes);
  app.route('/api/memberships', membershipRoutes);

  app.route('/api/projects', projectRoutes);
  app.route('/api/projects', assistantWeeklyRoutes);
  app.route('/api/orgs', orgRoutes);
  // No auth of its own: it answers under orgRoutes' gate, mounted just above on the same prefix.
  app.route('/api/orgs', deviceOrgRoutes);
  app.route('/api/orgs', sshKeyRoutes);
  app.route('/api/org-invitations', orgInvitationRoutes);
  app.route('/api/projects', integrationsRoutes);
  app.route('/api/projects', githubConnectRoutes);
  app.route('/api/projects', runnerReleaseRoutes);
  app.route('/api', githubCallbackRoutes);
  app.route('/api/projects', integrationTargetRoutes);
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.route('/api/projects', memberRoutes);
  app.route('/api/projects', divergenceCharterRoutes);
  app.route('/api/projects', skillSyncRoutes);
  app.route('/api/projects', skillRegisterRoutes);
  app.route('/api/projects', skillStudioRoutes);
  app.route('/api/projects', skillPinRoutes);
  app.route('/api/projects', skillSmokeVerifyRoutes);
  app.route('/api/projects', reconcileRoutes);
  app.route('/api/invitations', invitationRoutes);

  app.route('/api/projects', issueProjectRoutes);
  app.route('/api/projects', searchRoutes);
  app.route('/api/projects', issueStandingRoutes);
  app.route('/api/projects', developmentOverviewRoutes);
  app.route('/api/projects', needsYouRoutes);
  app.route('/api/projects', masterStandingRoutes);
  app.route('/api/projects', runStandingRoutes);
  app.route('/api/projects', issueArchiveRoutes);
  app.route('/api/projects', backlogStreamRoutes);
  app.route('/api/projects', labelProjectRoutes);
  app.route('/api/projects', moduleDiagramRoutes);
  app.route('/api/projects', projectActivityRoutes);
  app.route('/api/projects', jobProjectRoutes);

  app.route('/api/issues', issueAttachmentRoutes);
  app.route('/api/issues', issueExtrasRoutes);
  app.route('/api/issues', issueMergeRoutes);
  app.route('/api/uploads', uploadRoutes);
  app.route('/api/issues', issueRoutes);
  app.route('/api/issues', transitionRoutes);
  app.route('/api/issues', issueActivityRoutes);
  app.route('/api/issues', issueDependencyRoutes);
  app.route('/api/issues', issueSteerRoutes);
  app.route('/api/issues', issueCriteriaRoutes);
  app.route('/api/issues', contractWaitRoutes);
  app.route('/api/issues', taskIssueRoutes);
  app.route('/api/tasks', taskRoutes);
  app.route('/api/body', bodyRoutes);
  app.route('/api/comments', commentRoutes);
  app.route('/api/attachments', attachmentRoutes);
  app.route('/api/labels', labelRoutes);
  app.route('/api/jobs', jobRoutes);
  app.route('/api/jobs', jobEventsRoutes);
  app.route('/api/jobs', jobEventsListRoutes);
  app.route('/api/jobs', jobLifecycleDeviceRoutes);
  app.route('/api/jobs', jobLifecycleUserRoutes);
  app.route('/api/jobs', jobTestingSecretsRoutes);
  app.route('/api/webhooks', webhookInboundRoutes);
  app.route('/api/memory', memorySearchRoutes);
  app.route('/api/memory', memoryMineRoutes);
  app.route('/api/memory', memoryListRoutes);
  app.route('/api/memory', memoryWriteRoutes);
  app.route('/api/issue-step-contexts', stepHandoffRoutes);
  app.route('/api/prompts', promptRoutes);
  app.route('/api/skill-facts', skillFactsRoutes);
  app.route('/api/skill-activity', skillActivityRoutes);
  app.route('/api/update-packets', updatePacketRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.route('/api/me', meAttentionRoutes);
  app.route('/api/me', mePulseRoutes);
  app.route('/api/questions', questionRoutes);
  app.route('/api', speakerLinkProjectRoutes);
  app.route('/api', speakerLinkMeRoutes);
  app.route('/api/me', meRecentChangesRoutes);
  app.route('/api/agents', agentRoutes);
  app.route('/api/conversations', conversationRoutes);
  app.route('/api/agent-sessions', agentSessionAttachmentRoutes);
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.route('/api/pipeline-runs', phaseRoutes);
  app.route('/api/pipeline-runs', pipelineRunReadRoutes);
  app.route('/api/pipeline-runs', pipelineRunRoutes);
  app.route('/api/projects', pipelineRunProjectRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/admin', adminAggregateRoutes);
  app.route('/api/admin', adminAlertRoutes);
  app.route('/api/admin', adminMcpAuditRoutes);
  app.route('/api/admin', adminMetricSeriesRoutes);
  app.route('/api/admin', adminThresholdRoutes);
  app.route('/api/admin/pipeline', pipelineHealthAdminRoutes);
  app.route('/api/devices', devicePublicRoutes);
  app.route('/api/devices', deviceLoginRoutes);
  app.route('/api/devices', deviceGitCredentialRoutes);
  app.route('/api/devices', deviceAuthRoutes);
  app.route('/api/devices', deviceSkillRoutes);
  app.route('/api/devices', deviceMcpServerRoutes);
  app.route('/api/devices', devicePoolRoutes);
  app.route('/api/devices', deviceMasterRoutes);
  app.route('/api', deviceOwnerRoutes);
  app.route('/api/projects', deviceUserRoutes);
  app.route('/api/projects', deviceSkillStatusRoutes);
  app.route('/api/pipeline/registry', pipelineRegistryRoutes);
  app.route('/api/pipeline', pipelineAnalyticsRoutes);
  app.route('/api/projects', releaseBatchRoutes);
  app.route('/api/projects', projectCostAnalyticsRoutes);
  app.route('/api/schedules', scheduleRoutes);
  app.route('/api/agent-reports', agentReportRoutes);
  app.route('/api/feedback-reports', feedbackReportsAliasRoutes);
  app.route('/api/improvement-messages', improvementMessageRoutes);
  app.route('/api/knowledge', knowledgeIngestRoutes);
  app.route('/api/projects', knowledgeRoutes);
  app.route('/api/knowledge-edges', knowledgeEdgeRoutes);
  app.route('/api/skills', skillCrudRoutes);
  app.route('/api/usage-records', usageRecordRoutes);
  app.route('/api/chat-logs', chatLogRoutes);
  app.route('/api/app-config', memoryModelRoutes);
  app.route('/api/app-config', appConfigRoutes);
  app.route('/api/domain-templates', domainTemplateRoutes);
  app.route('/api/runners', runnerRoutes);

  if (isEnabled('pmAgent')) app.route('/api/projects', pmRoutes);
  app.route('/api/projects', pmReadRoutes);
  app.route('/api/projects', agentSessionProjectReadRoutes);
}
