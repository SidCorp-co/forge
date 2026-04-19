/**
 * Individual tool definitions for the Forge agent.
 */

import { forgeMemory } from '../memory-tool';
import { forgeCoolifyDeploy } from '../coolify-tool';
import { forgeSentry } from '../sentry-tool';
import { forgeSkills } from '../skills-tool';
import { forgeLanguage } from '../language-tool';
import { forgeConfig } from '../config-tool';
import { createCodeRunTool } from '../analysis-tools';
import { forgeClaude } from '../claude-tool';
import { forgeIntegrationGuide } from '../integration-guide-tool';
import { forgeProjects } from '../projects-tool';
import { forgeHealth } from '../health-tool';
import { forgePipeline } from '../pipeline-tool';
import { forgeActivity } from '../activity-tool';
import { forgeSchedule } from '../schedule-tool';
import { forgeCloudflare } from '../cloudflare-tool';
import type { ForgeTool } from './types';
import { resolveTargetProject } from './types';

const forgeIssues: ForgeTool = {
  name: 'forge_issues',
  description: 'CRUD for project issues. Actions: list, get, create, update. Use targetProjectSlug for cross-project access.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'create', 'update'] },
      targetProjectSlug: { type: 'string', description: 'Optional: access issues in a different project by slug (cross-project)' },
      filters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Text search on title and description (case-insensitive substring match)' },
          status: { type: 'string', enum: ['draft', 'open', 'confirmed', 'clarified', 'waiting', 'approved', 'in_progress', 'developed', 'deploying', 'testing', 'staging', 'released', 'closed', 'reopen', 'on_hold', 'needs_info'] },
          statusNot: { type: 'string' },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
          category: { type: 'string' },
          createdAfter: { type: 'string', description: 'ISO date — issues created on or after (e.g. "2026-02-28")' },
          createdBefore: { type: 'string', description: 'ISO date — issues created before (e.g. "2026-03-01")' },
          updatedAfter: { type: 'string', description: 'ISO date — issues updated on or after' },
        },
      },
      documentId: { type: 'string', description: 'For get/update' },
      data: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['draft', 'open', 'confirmed', 'clarified', 'waiting', 'approved', 'in_progress', 'developed', 'deploying', 'testing', 'staging', 'released', 'closed', 'reopen', 'on_hold', 'needs_info'] },
          priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low', 'none'] },
          category: { type: 'string' },
          complexity: { type: 'string', enum: ['Simple', 'Medium', 'Complex'] },
          acceptanceCriteria: { type: 'string' },
          plan: { type: 'string', description: 'Implementation plan (markdown)' },
          sessionContext: { type: 'object', description: 'Accumulated context across sessions: { lastUpdated, sessionCount, currentState, decisions[], filesModified[], errorsResolved[], reviewFeedback[] }' },
          attachments: { type: 'array', items: { type: 'number' }, description: 'Media IDs' },
          relations: { type: 'array', items: { type: 'object', properties: { type: { type: 'string', enum: ['related_to', 'caused_by', 'blocked_by', 'duplicate_of', 'fixed_by', 'depends_on'] }, targetDocumentId: { type: 'string' }, reason: { type: 'string' } } }, description: 'Issue relations' },
        },
      },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const docs = ctx.strapi.documents('api::issue.issue');

    let projectDocId = ctx.projectDocumentId;
    if (input.targetProjectSlug) {
      const target = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
      if (!target) return `Error: project with slug "${input.targetProjectSlug}" not found`;
      const isReadOnly = action === 'list' || action === 'get';
      if (!isReadOnly && !ctx.crossProjectAccess && !target.crossProjectAccess) {
        return `Error: cross-project write access denied. The target project does not accept cross-project writes.`;
      }
      projectDocId = target.documentId;
    }

    if (action === 'list') {
      const filters: Record<string, any> = {
        project: { documentId: { $eq: projectDocId } },
      };
      const f = input.filters as Record<string, string> | undefined;
      if (f?.search) {
        const issueCodeMatch = f.search.match(/^ISS-(\d+)$/i);
        if (issueCodeMatch) {
          filters.id = { $eq: parseInt(issueCodeMatch[1], 10) };
        } else {
          filters.$or = [
          { title: { $containsi: f.search } },
          { description: { $containsi: f.search } },
          ];
        }
      }
      if (f?.status) filters.status = { $eq: f.status };
      else if (f?.statusNot) filters.status = { $ne: f.statusNot };
      if (f?.priority) filters.priority = { $eq: f.priority };
      if (f?.category) filters.category = { $eq: f.category };
      if (f?.createdAfter) filters.createdAt = { ...filters.createdAt, $gte: f.createdAfter };
      if (f?.createdBefore) filters.createdAt = { ...filters.createdAt, $lt: f.createdBefore };
      if (f?.updatedAfter) filters.updatedAt = { $gte: f.updatedAfter };

      const issues = await docs.findMany({
        filters,
        populate: ['tasks'],
        sort: 'createdAt:desc',
      });

      return JSON.stringify(
        issues.map((i: any) => ({
          issueId: `ISS-${i.id}`,
          documentId: i.documentId,
          title: i.title,
          status: i.status,
          priority: i.priority,
          category: i.category,
          taskCount: i.tasks?.length ?? 0,
          createdAt: i.createdAt,
          updatedAt: i.updatedAt,
        })),
      );
    }

    if (action === 'create') {
      let data = input.data as Record<string, any>;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* leave as-is */ } }
      if (!data?.title) return 'Error: data.title required for create action';
      const defaultStatus = data.reportedBy?.toLowerCase().includes('agent') ? 'draft' : 'open';
      const { _historyActor: _, ...cleanData } = data as Record<string, any> & { _historyActor?: any };
      const isChatCreated = !ctx.pipelineSkill;
      const createData: Record<string, any> = {
        ...cleanData,
        status: cleanData.status || defaultStatus,
        priority: cleanData.priority || 'medium',
        project: { documentId: projectDocId },
        ...(isChatCreated && cleanData.manualHold === undefined ? { manualHold: true } : {}),
      };
      const created = await docs.create({ data: createData });
      return JSON.stringify({ issueId: `ISS-${created.id}`, documentId: created.documentId, title: created.title, status: 'created' });
    }

    if (action === 'get') {
      const id = input.documentId as string;
      if (!id) return 'Error: documentId required for get action';
      const issue = await docs.findOne({ documentId: id, populate: { tasks: true, comments: { populate: ['attachments'] }, attachments: true } }) as any;
      if (!issue) return 'Issue not found';

      const result: any = {
        issueId: `ISS-${issue.id}`,
        documentId: issue.documentId,
        title: issue.title,
        description: issue.description,
        status: issue.status,
        priority: issue.priority,
        category: issue.category,
        complexity: issue.complexity,
        acceptanceCriteria: issue.acceptanceCriteria,
        plan: issue.plan,
        sessionContext: issue.sessionContext || null,
        createdAt: issue.createdAt,
        updatedAt: issue.updatedAt,
        tasks: issue.tasks?.map((t: any) => ({
          documentId: t.documentId,
          title: t.title,
          status: t.status,
        })) ?? [],
        comments: (issue.comments || [])
          .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
          .slice(0, 5)
          .map((c: any) => ({
            documentId: c.documentId,
            body: c.body,
            author: c.author,
            createdAt: c.createdAt,
            attachments: (c.attachments || []).map((a: any) => ({
              id: a.id,
              url: a.url,
              name: a.name,
              mime: a.mime,
            })),
          })),
      };

      if (issue.attachments?.length) {
        const baseUrl = process.env.FORGE_PUBLIC_URL || 'http://localhost:1337';
        result.attachments = issue.attachments.map((a: any) => ({
          name: a.name,
          mime: a.mime,
          url: a.url?.startsWith('http') ? a.url : `${baseUrl}${a.url}`,
        }));
      }

      if (Array.isArray(issue.changeHistory) && issue.changeHistory.length > 0) {
        result.changeHistory = issue.changeHistory.map((e: any) =>
          `[${e.at}] ${e.by} changed ${e.field} from "${e.from ?? 'none'}" to "${e.to}"`
        );
      }

      return JSON.stringify(result);
    }

    if (action === 'update') {
      const id = input.documentId as string;
      let data = input.data as Record<string, unknown>;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* leave as-is */ } }
      if (!id || !data) return 'Error: documentId and data required for update action';
      const { _historyActor: _, ...cleanData } = data as Record<string, unknown> & { _historyActor?: unknown };

      if (cleanData.plan) {
        const planStr = typeof cleanData.plan === 'string' ? cleanData.plan : JSON.stringify(cleanData.plan);
        ctx.strapi.log.info(`[forge_issues] update ${id}: plan field received, length=${planStr.length}`);
      }

      const updated = await docs.update({ documentId: id, data: cleanData });

      if (cleanData.plan) {
        const verify = await docs.findOne({ documentId: id, fields: ['plan'] });
        const savedLen = typeof (verify as any)?.plan === 'string' ? (verify as any).plan.length : 0;
        if (savedLen !== (typeof cleanData.plan === 'string' ? cleanData.plan.length : 0)) {
          ctx.strapi.log.warn(`[forge_issues] update ${id}: plan TRUNCATED! sent=${typeof cleanData.plan === 'string' ? cleanData.plan.length : '?'} saved=${savedLen}`);
        }
      }

      // Pipeline triggering on status change is handled by the issue lifecycle
      // hook (afterUpdate → triggerPipelineStep). No explicit call needed here —
      // an extra manual=true call would bypass toggle checks and double-queue
      // the next step.

      if (cleanData.plan && !(updated as any).plan) {
        return `Error: plan field was sent but not saved for ${id}. Check Strapi logs.`;
      }
      return JSON.stringify({ documentId: updated.documentId, status: 'updated' });
    }

    return `Unknown action: ${action}`;
  },
};

const forgeComments: ForgeTool = {
  name: 'forge_comments',
  description: 'List or create issue comments. Use targetProjectSlug for cross-project access.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create'] },
      targetProjectSlug: { type: 'string', description: 'Optional: access comments in a different project by slug (cross-project)' },
      filters: { type: 'object', properties: { issue: { type: 'string' } } },
      limit: { type: 'number', description: 'Max comments to return (default 10, max 50)' },
      data: {
        type: 'object',
        properties: {
          body: { type: 'string' },
          issue: { type: 'string' },
          author: { type: 'string' },
          attachments: { type: 'array', items: { type: 'number' }, description: 'Media IDs to attach (optional)' },
        },
      },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const docs = ctx.strapi.documents('api::comment.comment');

    let projectDocId: string | null = null;
    if (input.targetProjectSlug) {
      const target = await resolveTargetProject(ctx.strapi, input.targetProjectSlug as string);
      if (!target) return `Error: project with slug "${input.targetProjectSlug}" not found`;
      const isReadOnly = action === 'list';
      if (!isReadOnly && !ctx.crossProjectAccess && !target.crossProjectAccess) {
        return `Error: cross-project write access denied. The target project does not accept cross-project writes.`;
      }
      projectDocId = target.documentId;
    }

    if (action === 'list') {
      const filters: Record<string, any> = {};
      const f = input.filters as Record<string, string> | undefined;
      if (f?.issue) filters.issue = { documentId: { $eq: f.issue } };
      if (projectDocId) filters.issue = { ...filters.issue, project: { documentId: { $eq: projectDocId } } };

      const reqLimit = Math.min(Math.max((input.limit as number) || 10, 1), 50);
      const populate = projectDocId ? ['issue', 'issue.project', 'attachments'] : ['issue', 'attachments'];
      const comments = await docs.findMany({ filters, populate, sort: 'createdAt:desc', limit: reqLimit });
      return JSON.stringify(
        comments.map((c: any) => ({
          documentId: c.documentId,
          body: c.body,
          author: c.author,
          createdAt: c.createdAt,
          attachments: (c.attachments || []).map((a: any) => ({
            id: a.id,
            url: a.url,
            name: a.name,
            mime: a.mime,
          })),
        })),
      );
    }

    if (action === 'create') {
      const data = input.data as Record<string, any>;
      if (!data?.body || !data?.issue) return 'Error: data.body and data.issue required';
      if (projectDocId) {
        const targetIssue = await ctx.strapi.documents('api::issue.issue').findOne({
          documentId: data.issue,
          populate: ['project'],
          fields: ['documentId'],
        });
        if (!targetIssue?.project?.documentId || targetIssue.project.documentId !== projectDocId) {
          return `Error: issue "${data.issue}" does not belong to the target project`;
        }
      }
      const createData: Record<string, any> = {
        body: data.body,
        author: data.author || 'Forge AI',
        isAI: true,
        issue: { documentId: data.issue },
      };
      if (data.attachments) createData.attachments = data.attachments;
      const created = await docs.create({ data: createData });
      return JSON.stringify({ documentId: created.documentId, status: 'created' });
    }

    return `Unknown action: ${action}`;
  },
};

const forgeAgentSessions: ForgeTool = {
  name: 'forge_agent_sessions',
  description: 'Manage desktop agent sessions. Actions: start, list, get, send.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['start', 'list', 'get', 'send'] },
      data: { type: 'object', description: 'start: {prompt, issueIds?, preview?}. send: {sessionId, message}.' },
      documentId: { type: 'string', description: 'For get action' },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;
    const UID = 'api::agent-session.agent-session' as any;
    const docs = ctx.strapi.documents(UID);

    if (action === 'list') {
      const sessions = await docs.findMany({
        filters: { project: { documentId: { $eq: ctx.projectDocumentId } } },
        sort: { createdAt: 'desc' },
        limit: 20,
      });
      return JSON.stringify(
        sessions.map((s: any) => ({
          documentId: s.documentId,
          title: s.title,
          status: s.status,
          createdAt: s.createdAt,
        })),
      );
    }

    if (action === 'get') {
      const id = input.documentId as string;
      if (!id) return 'Error: documentId required for get action';
      const session = await docs.findOne({ documentId: id, populate: ['issues'] }) as any;
      if (!session) return 'Session not found';
      const messages = Array.isArray(session.messages) ? session.messages.slice(-10) : [];
      return JSON.stringify({
        documentId: session.documentId,
        title: session.title,
        status: session.status,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        messageCount: session.messages?.length ?? 0,
        recentMessages: messages.map((m: any) => ({
          role: m.role,
          content: typeof m.content === 'string' ? m.content.slice(0, 500) : m.content,
          timestamp: m.timestamp,
        })),
        issues: session.issues?.map((i: any) => ({
          documentId: i.documentId,
          title: i.title,
          status: i.status,
        })),
      });
    }

    if (action === 'start') {
      const data = input.data as Record<string, any>;
      if (!data?.prompt) return 'Error: data.prompt required for start action';

      const { sendToDevice: wsSendToDevice, isAnyDeviceConnected: wsIsAnyDeviceConnected, broadcast } = require('../../services/websocket');
      const { findAvailableDevice: poolFindDevice, clearDeviceAllocation: poolClearAlloc } = require('../../services/device-pool');
      const { resolveRepoPath: resolveRp } = require('../../services/resolve-repo-path');

      const projects = await ctx.strapi.documents('api::project.project').findMany({
        filters: { documentId: { $eq: ctx.projectDocumentId } },
        limit: 1,
      });
      const project = projects[0] as any;
      if (!project) return 'Error: Project not found';

      let deviceId: string | null = (await poolFindDevice(ctx.projectDocumentId))?.deviceId ?? null;
      if (!deviceId && wsIsAnyDeviceConnected()) deviceId = 'default';
      if (!deviceId) {
        return 'Error: No desktop device available. Connect a Forge desktop app first.';
      }

      const prompt = data.prompt as string;
      const issueIds = data.issueIds?.length ? data.issueIds : [];

      if (data.preview) {
        broadcast('agent:preview-prompt', {
          prompt,
          issueIds,
          projectSlug: project.slug,
        });
        return JSON.stringify({
          status: 'preview',
          message: 'Prompt sent to web UI for review. User can edit and start the session from the agent page.',
        });
      }

      const title = prompt
        .replace(/^You are working on issue:\s*/i, '')
        .replace(/^You are working on the following issues:\s*/i, '')
        .replace(/^You are working on:\s*/i, '')
        .slice(0, 120);
      const now = Date.now();
      const messages = [{ role: 'user', content: prompt, timestamp: now }];

      const rp = await resolveRp(ctx.strapi, project.slug, deviceId, undefined, project.repoPath);

      const sessionData: any = {
        title,
        status: 'running',
        messages,
        project: project.documentId,
        repoPath: rp,
        metadata: { deviceId },
      };

      if (issueIds.length) {
        sessionData.issues = issueIds;
      }

      const session = await docs.create({ data: sessionData });
      if (deviceId !== 'default') poolClearAlloc(deviceId);
      const sid = session.documentId;

      setTimeout(() => {
        wsSendToDevice(deviceId, 'agent:start', { sessionId: sid, repoPath: rp, prompt, projectSlug: project.slug, projectDocumentId: project.documentId });
      }, 500);

      return JSON.stringify({
        documentId: sid,
        title,
        status: 'running',
        message: 'Agent session started. Desktop agent is executing the prompt.',
      });
    }

    if (action === 'send') {
      const data = input.data as Record<string, any>;
      if (!data?.sessionId || !data?.message) return 'Error: data.sessionId and data.message required for send action';

      const { sendToDevice: wsSendToDevice, isAnyDeviceConnected: wsIsAnyDeviceConnected } = require('../../services/websocket');
      const { findAvailableDevice: poolFindDevice } = require('../../services/device-pool');

      let deviceId: string | null = (await poolFindDevice(ctx.projectDocumentId))?.deviceId ?? null;
      if (!deviceId && wsIsAnyDeviceConnected()) deviceId = 'default';
      if (!deviceId) {
        return 'Error: No desktop device available.';
      }

      const session: any = await docs.findOne({ documentId: data.sessionId });
      if (!session) return 'Error: Session not found';

      const msg = { role: 'user', content: data.message, timestamp: Date.now() };
      const updatedMessages = [...(session.messages || []), msg];
      await docs.update({ documentId: data.sessionId, data: { messages: updatedMessages } });

      wsSendToDevice(deviceId, 'agent:send', {
        sessionId: data.sessionId,
        message: data.message,
        claudeSessionId: session.claudeSessionId,
        projectSlug: session.project?.slug,
      });

      return JSON.stringify({ documentId: data.sessionId, status: 'message_sent' });
    }

    return `Unknown action: ${action}`;
  },
};

const forgeTodoWrite: ForgeTool = {
  name: 'TodoWrite',
  description: 'Show progress checklist in UI. Each call replaces previous.',
  parameters: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: { type: 'object', properties: { content: { type: 'string' }, status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] } }, required: ['content', 'status'] },
      },
    },
    required: ['todos'],
  },
  async execute() {
    return 'ok';
  },
};

const forgeCodeRun = createCodeRunTool('/tmp/forge-sandbox');

export {
  forgeIssues,
  forgeComments,
  forgeAgentSessions,
  forgeMemory,
  forgeLanguage,
  forgeCoolifyDeploy,
  forgeSentry,
  forgeCloudflare,
  forgeSkills,
  forgeConfig,
  forgeTodoWrite,
  forgeCodeRun,
  forgeClaude,
  forgeIntegrationGuide,
  forgeProjects,
  forgeHealth,
  forgePipeline,
  forgeActivity,
  forgeSchedule,
};
