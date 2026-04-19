import type { ForgeTool } from './tools';
import { resolveTargetProject } from './tools';
import { listDomainTemplates, getDomainTemplate } from './domain-templates';

export const forgeConfig: ForgeTool = {
  name: 'forge_config',
  description: 'Project config. Actions: get, set, reset, list_templates, apply_template, get_knowledge, get_conventions. Use targetProjectSlug for cross-project access.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['get', 'set', 'reset', 'list_templates', 'apply_template', 'get_knowledge', 'get_conventions'] },
      config: {
        type: 'object',
        description: 'Partial config to merge (for set action). Includes both agentConfig fields and project-level fields.',
        properties: {
          statuses: { type: 'array', items: { type: 'string' } },
          priorities: { type: 'array', items: { type: 'string' } },
          categories: { type: 'array', items: { type: 'string' } },
          relationTypes: { type: 'array', items: { type: 'string' } },
          enabledTools: { type: 'array', items: { type: 'string' } },
          agentName: { type: 'string', description: 'Display name for the AI assistant (e.g. "Forge AI", "HR Assistant")' },
          agentRole: { type: 'string', description: 'Custom core behavior description for the assistant' },
          behaviorRules: { type: 'array', items: { type: 'string' }, description: 'Domain-specific behavioral instructions for the agent' },
          queryStrategies: { type: 'object', description: 'Intent → strategy text overrides (keys: LOOKUP, CREATE, SUMMARY, SEARCH, CHAT, ACTION)' },
          intentExamples: { type: 'array', items: { type: 'string' }, description: 'Few-shot intent classification examples (e.g. \'"show open bugs" → LOOKUP\')' },
          domainTemplate: { type: 'string', description: 'Domain template key (e.g. "issue_tracker", "hrm", "task_management", "crm", "helpdesk", "knowledge_base")' },
          baseBranch: { type: 'string', description: 'Project base branch (e.g. "main", "master", "develop")' },
          repoPath: { type: 'string', description: 'Path to repository on disk' },
          productionBranch: { type: 'string', description: 'Production branch name' },
          previewDeploy: { type: 'object', description: 'Staging deploy config (stagingUrl, stagingApiUrl, testCredentials, repoUrl, envVars)' },
          pipelineConfig: { type: 'object', description: 'Pipeline configuration (enabled, autoTriage, autoPlan, autoCode, etc.)' },
          crossProjectAccess: { type: 'boolean', description: 'Enable cross-project access for this project (admin only)' },
          projectMeta: { type: 'object', description: 'Project metadata JSON (stack, capabilities, exposes)' },
          // Chat Agent
          agentPrompt: { type: 'string', description: 'Custom guidelines/prompt for the chat agent' },
          agentMemoryEnabled: { type: 'boolean', description: 'Enable/disable agent memory' },
          enabledSkills: { type: 'array', items: { type: 'string' }, description: 'Cloud skills selection (skill names to enable)' },
          // Providers
          defaultProvider: { type: 'string', enum: ['anthropic', 'openai', 'gemini'], description: 'Default AI provider' },
          agentProvider: { type: 'string', enum: ['anthropic', 'openai', 'gemini'], description: 'Agent-specific AI provider' },
          // Integrations
          coolifyResources: { type: 'array', items: { type: 'object' }, description: 'Coolify deployment resources array ({name, uuid})' },
          sentryProject: { type: 'string', description: 'Sentry project ID' },
          antigravityProjectId: { type: 'string', description: 'Antigravity project ID' },
          webhookUrl: { type: 'string', description: 'Generic webhook endpoint URL' },
          webhookSecret: { type: 'string', description: 'Webhook secret for signature verification' },
          webhookStatuses: { type: 'array', items: { type: 'string' }, description: 'Issue statuses that trigger the webhook' },
          conventions: { type: 'string', description: 'Project coding conventions (markdown)' },
          knowledgeIndex: { type: 'object', description: 'Codebase knowledge index (JSON from .forge/knowledge.json)' },
        },
      },
      targetProjectSlug: { type: 'string', description: 'Optional: access config in a different project by slug (cross-project)' },
      templateKey: { type: 'string', description: 'Template key for apply_template action' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const docs = ctx.strapi.documents('api::project.project');

    // Resolve cross-project access if targetProjectSlug is provided
    let projectDocId = ctx.projectDocumentId;
    if (input.targetProjectSlug) {
      if (!ctx.crossProjectAccess) {
        return 'Error: crossProjectAccess required to manage config in other projects.';
      }
      const target = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
      if (!target) return `Error: project with slug "${input.targetProjectSlug}" not found`;
      projectDocId = target.documentId;
    }

    if (action === 'get') {
      const projects = await docs.findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['agentConfig', 'baseBranch', 'productionBranch', 'repoPath', 'previewDeploy', 'defaultProvider', 'agentProvider', 'agentPrompt', 'agentMemoryEnabled', 'coolifyResources', 'sentryProject', 'antigravityProjectId', 'webhookUrl', 'webhookSecret', 'webhookStatuses'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';
      const pd = project.previewDeploy || {};
      const ac = project.agentConfig || {};
      return JSON.stringify({
        agentConfig: project.agentConfig || null,
        baseBranch: project.baseBranch || 'main',
        productionBranch: project.productionBranch || null,
        repoPath: project.repoPath || null,
        previewDeploy: {
          testingUrls: pd.testingUrls || [],
          stagingUrl: pd.stagingUrl || null,
          stagingApiUrl: pd.stagingApiUrl || null,
          testCredentials: pd.testCredentials || [],
          repoUrl: pd.repoUrl || null,
          useRegistry: pd.useRegistry || false,
          envVars: pd.envVars || {},
        },
        defaultProvider: project.defaultProvider || 'anthropic',
        agentProvider: project.agentProvider || null,
        agentPrompt: project.agentPrompt || null,
        agentMemoryEnabled: project.agentMemoryEnabled !== false,
        enabledSkills: ac.enabledSkills || [],
        coolifyResources: project.coolifyResources || [],
        sentryProject: project.sentryProject || null,
        antigravityProjectId: project.antigravityProjectId || null,
        webhookUrl: project.webhookUrl || null,
        webhookSecret: project.webhookSecret || null,
        webhookStatuses: project.webhookStatuses || [],
      });
    }

    if (action === 'set') {
      const partial = input.config as Record<string, any>;
      if (!partial) return 'Error: config required for set action';

      // Separate project-level fields from agentConfig fields
      // NOTE: pipelineConfig is NOT a project-level field — it lives in agentConfig.pipelineConfig
      const PROJECT_FIELDS = ['baseBranch', 'repoPath', 'productionBranch', 'previewDeploy', 'crossProjectAccess', 'projectMeta', 'defaultProvider', 'agentProvider', 'agentPrompt', 'agentMemoryEnabled', 'coolifyResources', 'sentryProject', 'antigravityProjectId', 'webhookUrl', 'webhookSecret', 'webhookStatuses', 'conventions', 'knowledgeIndex'];
      const projectFields: Record<string, any> = {};
      const agentConfigFields: Record<string, any> = {};

      for (const [key, value] of Object.entries(partial)) {
        if (PROJECT_FIELDS.includes(key)) {
          projectFields[key] = value;
        } else if (key === 'pipelineConfig') {
          // pipelineConfig merges into agentConfig.pipelineConfig (canonical location)
          agentConfigFields[key] = value;
        } else {
          agentConfigFields[key] = value;
        }
      }

      // Guard crossProjectAccess write behind cross-project access check
      if (projectFields.crossProjectAccess !== undefined && !ctx.crossProjectAccess) {
        return 'Error: cross-project access required to modify crossProjectAccess. Only admins/CEO can change this setting.';
      }

      const projects = await docs.findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['agentConfig'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      const updateData: Record<string, any> = {};

      // Update project-level fields directly
      if (Object.keys(projectFields).length > 0) {
        Object.assign(updateData, projectFields);
      }

      // Merge agentConfig fields into existing agentConfig
      if (Object.keys(agentConfigFields).length > 0) {
        const merged = { ...(project.agentConfig || {}), ...agentConfigFields };
        updateData.agentConfig = merged;
      }

      await docs.update({ documentId: projectDocId, data: updateData });

      const updatedKeys = Object.keys(partial);
      return JSON.stringify({ status: 'updated', updatedKeys });
    }

    if (action === 'reset') {
      await docs.update({ documentId: projectDocId, data: { agentConfig: null } });
      return JSON.stringify({ status: 'reset', agentConfig: null });
    }

    if (action === 'list_templates') {
      return JSON.stringify(await listDomainTemplates(ctx.strapi));
    }

    if (action === 'apply_template') {
      const key = (input.templateKey as string) || '';
      const template = await getDomainTemplate(ctx.strapi, key);
      if (!template) return `Error: Unknown template "${key}". Use list_templates to see available options.`;

      const projects = await docs.findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['agentConfig'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      // Flatten template config into project agentConfig (editable per-project)
      const merged = {
        ...(project.agentConfig || {}),
        ...template.config,
        domainTemplate: key, // track origin for reference only
      };
      await docs.update({ documentId: projectDocId, data: { agentConfig: merged } });
      return JSON.stringify({ status: 'applied', template: key, label: template.label });
    }

    if (action === 'get_knowledge') {
      const projects = await docs.findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['knowledgeIndex'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';
      if (!project.knowledgeIndex) return 'No knowledge indexed yet';
      return JSON.stringify(project.knowledgeIndex);
    }

    if (action === 'get_conventions') {
      const projects = await docs.findMany({
        filters: { documentId: { $eq: projectDocId } },
        fields: ['conventions'],
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';
      if (!project.conventions) return 'No conventions stored yet';
      return project.conventions;
    }

    return `Unknown action: ${action}`;
  },
};
