// The one route-mount registry: every module's routers, imported from its heavy face (routes.ts) and
// mounted in the order Hono matches them. Order is load-bearing: a router's `use('*')` gates every
// later router mounted under the same prefix, so the area functions below run in sequence.

import type { Hono } from 'hono';
import {
  adminAggregateRoutes,
  adminAlertRoutes,
  adminMcpAuditRoutes,
  adminMetricSeriesRoutes,
  adminRoutes,
  pipelineHealthAdminRoutes,
} from './admin/routes.js';
import { adminThresholdRoutes } from './admin-thresholds/routes.js';
import { agentReportRoutes, feedbackReportsAliasRoutes } from './agent-reports/routes.js';
import {
  agentSessionAttachmentRoutes,
  agentSessionProjectReadRoutes,
  agentSessionRoutes,
} from './agent-sessions/routes.js';
import { appConfigRoutes } from './app-config/routes.js';
import {
  baDoorRoutes,
  conversationRoutes,
  speakerLinkMeRoutes,
  speakerLinkProjectRoutes,
} from './assistant/routes.js';
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
} from './auth/routes.js';
import { automationRoutes } from './automation/routes.js';
import { commentRoutes, entityCommentRoutes } from './comments/routes.js';
import { contentLanguageRoutes } from './content-language/routes.js';
import { developmentOverviewRoutes, needsYouRoutes } from './development/routes.js';
import {
  deviceAuthRoutes,
  deviceLoginRoutes,
  deviceMcpServerRoutes,
  deviceOrgRoutes,
  deviceOwnerRoutes,
  devicePoolRoutes,
  devicePublicRoutes,
  deviceUserRoutes,
  runLedgerRoutes,
} from './devices/routes.js';
import { ecosystemJsonSchemas } from './ecosystem/index.js';
import {
  busRoutes,
  channelProjectRoutes,
  contractRequestRoutes,
  contractRoutes,
  contractStandingRoutes,
  contractWaitRoutes,
  deviceChannelInboxRoutes,
  ecosystemProjectRoutes,
  ecosystemRoutes,
  linkProjectRoutes,
  membershipRoutes,
} from './ecosystem/routes.js';
import { feedbackRoutes } from './feedback/routes.js';
import { deviceGitCredentialRoutes } from './git/routes.js';
import { guideRoutes } from './guides/routes.js';
import {
  opsHealthMeRoutes,
  opsHealthProjectRoutes,
  projectHealthRoutes,
  publicHealthRoutes,
} from './health/routes.js';
import { improvementMessageRoutes } from './improvement-messages/routes.js';
import { installRoutes } from './install/routes.js';
import {
  githubCallbackRoutes,
  githubConnectRoutes,
  integrationConnectionsRoutes,
  integrationsRoutes,
} from './integration-door/routes.js';
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
} from './issues/routes.js';
import {
  jobEventsListRoutes,
  jobEventsRoutes,
  jobLifecycleDeviceRoutes,
  jobLifecycleUserRoutes,
  jobProjectRoutes,
  jobRoutes,
} from './jobs/routes.js';
import { knowledgeIngestRoutes, knowledgeRoutes } from './knowledge/routes.js';
import { knowledgeEdgeRoutes } from './knowledge-edges/routes.js';
import { labelProjectRoutes, labelRoutes, moduleDiagramRoutes } from './labels/routes.js';
import { deviceMasterRoutes, masterStandingRoutes } from './masters/routes.js';
import { mcpHandler, mcpRequestClass } from './mcp/index.js';
import { meAttentionRoutes, mePulseRoutes, meRecentChangesRoutes } from './me/routes.js';
import {
  memoryListRoutes,
  memoryMineRoutes,
  memoryModelRoutes,
  memorySearchRoutes,
  memoryWriteRoutes,
} from './memory/routes.js';
import { projectMetricsRoutes } from './metrics/routes.js';
import type { RequestIdVars } from './middleware/request-id.js';
import { requirePat } from './middleware/require-pat.js';
import { mockupRoutes } from './mockups/routes.js';
import { notificationRoutes } from './notifications/routes.js';
import { onboardingRoutes } from './onboarding/routes.js';
import { orgInvitationRoutes, orgRoutes, sshKeyRoutes } from './orgs/routes.js';
import { outboxAdminRoutes, outboxRoutes } from './outbox/routes.js';
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
} from './pipeline/routes.js';
import { pmReadRoutes } from './pm/read-routes.js';
import { orgMemberPreferenceRoutes, preferenceRoutes } from './preferences/routes.js';
import {
  environmentStateRoutes,
  jobTestingSecretsRoutes,
  projectConfigRoutes,
  projectConfigSchemaRoutes,
} from './project-config/routes.js';
import {
  collaboratorsMeRoutes,
  gitCredentialRoutes,
  invitationRoutes,
  masterCharterRoutes,
  memberRoutes,
  projectRoutes,
} from './projects/routes.js';
import { promptRoutes } from './prompt/routes.js';
import { questionnaireRoutes } from './questionnaires/routes.js';
import { questionRoutes } from './questions/routes.js';
import { releaseBatchRoutes } from './release-batch/routes.js';
import { requirementRoutes } from './requirements/routes.js';
import { mcpMessageBody, mcpNoBody, rootRoutes } from './root-routes.js';
import { projectRunnerRoutes, runnerRoutes } from './runners/routes.js';
import { runStandingRoutes } from './runs/routes.js';
import { scheduleRoutes } from './schedules/routes.js';
import { skillFactsRoutes } from './skill-facts/routes.js';
import {
  deviceSkillRoutes,
  projectOnboardRoutes,
  skillActivityRoutes,
  skillCrudRoutes,
  skillPinRoutes,
  skillStudioRoutes,
} from './skills/routes.js';
import { suggestionRoutes } from './suggestions/routes.js';
import { taskIssueRoutes, taskRoutes } from './tasks/routes.js';
import { uploadRoutes } from './uploads/routes.js';
import { webhookInboundRoutes } from './webhooks/routes.js';
import { workflowJsonSchemas } from './workflows/index.js';
import { workflowRoutes, workflowTemplateCatalogueRoutes } from './workflows/routes.js';

export function mountRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  mountPublicDoors(app);
  mountAccountRoutes(app);
  mountProjectDocumentRoutes(app);
  mountEcosystemRoutes(app);
  mountProjectAndOrgRoutes(app);
  mountProjectWorkRoutes(app);
  mountIssueAndJobRoutes(app);
  mountAgentRoutes(app);
  mountAdminAndDeviceRoutes(app);
  mountRemainingRoutes(app);
}

/** The unauthenticated surfaces: health, the MCP endpoint, install, guides and the root. */
function mountPublicDoors(app: Hono<{ Variables: RequestIdVars }>): void {
  for (const at of ['/', '/api']) app.route(at, publicHealthRoutes);

  app.use('/mcp', mcpRequestClass(), requirePat());
  app.post('/mcp', mcpMessageBody, mcpHandler);
  app.on(['GET', 'DELETE'], '/mcp', mcpNoBody, mcpHandler);

  for (const at of ['/', '/api']) app.route(at, installRoutes);
  for (const at of ['/', '/api']) app.route(at, guideRoutes);

  app.route('/', rootRoutes);
}

/** Sign-in, the caller's own account, and project reads mounted ahead of the project router. */
function mountAccountRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
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
}

/** The project document, its designs and the entity routes under a project. */
function mountProjectDocumentRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api', projectConfigSchemaRoutes(ecosystemJsonSchemas, workflowJsonSchemas));
  app.route('/api/workflow-templates', workflowTemplateCatalogueRoutes);
  app.route('/api/projects', projectConfigRoutes);
  app.route('/api/projects', environmentStateRoutes);
  app.route('/api/projects', workflowRoutes);
  app.route('/api/projects', requirementRoutes);
  app.route('/api/projects', suggestionRoutes);
  app.route('/api/projects', feedbackRoutes);
  app.route('/api/projects', mockupRoutes);
  app.route('/api/projects', outboxRoutes);
  app.route('/api/projects', baDoorRoutes);
  app.route('/api/projects', onboardingRoutes);
  app.route('/api/projects', questionnaireRoutes);
  app.route('/api/projects', contentLanguageRoutes);
  app.route('/api/projects', entityCommentRoutes);
  app.route('/api/projects', automationRoutes);
}

/** Ecosystems, their channels, contracts and memberships. */
function mountEcosystemRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api/projects', ecosystemProjectRoutes);
  app.route('/api/projects', channelProjectRoutes);
  app.route('/api/projects', contractRoutes);
  app.route('/api/projects', linkProjectRoutes);
  app.route('/api/projects', contractRequestRoutes);
  app.route('/api/projects', contractStandingRoutes);
  app.route('/api/ecosystems', ecosystemRoutes);
  app.route('/api/ecosystems', busRoutes);
  app.route('/api/memberships', membershipRoutes);
}

/** Projects, orgs, integrations, members and skills. */
function mountProjectAndOrgRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api/projects', projectRoutes);
  // No auth of their own: they answer under projectRoutes' gate, mounted just above on the same prefix.
  app.route('/api/projects', projectRunnerRoutes);
  app.route('/api/projects', projectOnboardRoutes);
  app.route('/api/orgs', orgRoutes);
  // No auth of their own: they answer under orgRoutes' gate, mounted just above on the same prefix.
  app.route('/api/orgs', deviceOrgRoutes);
  app.route('/api/orgs', orgMemberPreferenceRoutes);
  app.route('/api/orgs', sshKeyRoutes);
  app.route('/api/org-invitations', orgInvitationRoutes);
  app.route('/api/projects', integrationsRoutes);
  app.route('/api/projects', githubConnectRoutes);
  app.route('/api', githubCallbackRoutes);
  app.route('/api/integration-connections', integrationConnectionsRoutes);
  app.route('/api/projects', memberRoutes);
  app.route('/api/projects', skillStudioRoutes);
  app.route('/api/projects', skillPinRoutes);
  app.route('/api/invitations', invitationRoutes);
}

/** The work views under a project: issues, standing, labels and jobs. */
function mountProjectWorkRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
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
}

/** Issues, tasks, comments, attachments, labels, jobs, inbound webhooks and memory. */
function mountIssueAndJobRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
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
}

/** Prompts, skills, notifications, questions, agents, conversations, sessions and pipeline runs. */
function mountAgentRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api/issue-step-contexts', stepHandoffRoutes);
  app.route('/api/prompts', promptRoutes);
  app.route('/api/skill-facts', skillFactsRoutes);
  app.route('/api/skill-activity', skillActivityRoutes);
  app.route('/api/notifications', notificationRoutes);
  app.route('/api/me', meAttentionRoutes);
  app.route('/api/me', mePulseRoutes);
  app.route('/api/questions', questionRoutes);
  app.route('/api', speakerLinkProjectRoutes);
  app.route('/api', speakerLinkMeRoutes);
  app.route('/api/me', meRecentChangesRoutes);
  app.route('/api/conversations', conversationRoutes);
  app.route('/api/agent-sessions', agentSessionAttachmentRoutes);
  app.route('/api/agent-sessions', agentSessionRoutes);
  app.route('/api/pipeline-runs', phaseRoutes);
  app.route('/api/pipeline-runs', pipelineRunReadRoutes);
  app.route('/api/pipeline-runs', pipelineRunRoutes);
  app.route('/api/projects', pipelineRunProjectRoutes);
}

/** The admin console and the runner devices. */
function mountAdminAndDeviceRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
  app.route('/api/admin', adminRoutes);
  app.route('/api/admin', adminAggregateRoutes);
  app.route('/api/admin', adminAlertRoutes);
  app.route('/api/admin', adminMcpAuditRoutes);
  app.route('/api/admin', adminMetricSeriesRoutes);
  app.route('/api/admin', adminThresholdRoutes);
  app.route('/api/admin', outboxAdminRoutes);
  app.route('/api/admin/pipeline', pipelineHealthAdminRoutes);
  app.route('/api/devices', devicePublicRoutes);
  app.route('/api/devices', deviceLoginRoutes);
  app.route('/api/devices', deviceGitCredentialRoutes);
  app.route('/api/devices', deviceAuthRoutes);
  app.route('/api/devices', deviceSkillRoutes);
  app.route('/api/devices', deviceMcpServerRoutes);
  app.route('/api/devices', devicePoolRoutes);
  app.route('/api/devices', deviceChannelInboxRoutes);
  app.route('/api/devices', deviceMasterRoutes);
  app.route('/api', deviceOwnerRoutes);
  app.route('/api/projects', deviceUserRoutes);
}

/** Pipeline analytics, release batches, schedules, knowledge and the remaining resources. */
function mountRemainingRoutes(app: Hono<{ Variables: RequestIdVars }>): void {
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
  app.route('/api/app-config', memoryModelRoutes);
  app.route('/api/app-config', appConfigRoutes);
  app.route('/api/runners', runnerRoutes);

  app.route('/api/projects', pmReadRoutes);
  app.route('/api/projects', agentSessionProjectReadRoutes);
}
