// @direct-test-of packages/core/src/assistant/tools/mcp-adapter.ts
// @direct-test-of packages/core/src/assistant/tools/registry.ts
// @direct-test-of packages/core/src/assistant/tools/ba-tools.ts
// @direct-test-of packages/core/src/assistant/tools/ba-first-tools.ts
import { describe, expect, it } from 'vitest';
import {
  buildBaFirstRequirementsToolset,
  buildRequirementDraftToolset,
} from './assistant/tools/ba-first-tools.js';
import { buildBaToolset } from './assistant/tools/ba-tools.js';
import { buildToolset } from './assistant/tools/mcp-adapter.js';
import {
  buildProjectToolset,
  buildRecordToolset,
  provideChatTools,
} from './assistant/tools/registry.js';
import { CHAT_PROVIDED_TOOLS } from './chat-tools.js';
import type { McpContext } from './lib/tool.js';
import { onArg } from './permissions/index.js';
import { provideReportPorts } from './report-ports.js';
import { registerReportQueries } from './report-queries/index.js';

// ISS-947: every tool the chat assistant serves runs through `runDeclaredTool`, which refuses an act
// that declares no permission, and none of them is in the published MCP contract that would have
// caught it. Each toolset is refused where it is built, naming the tool; this walks every one.

const PROJECT = '00000000-0000-4000-8000-000000000001';
const ctx = {
  principal: { userId: '00000000-0000-4000-8000-000000000002', permissions: null },
  projectSlug: null,
  boundProjectId: PROJECT,
} as unknown as McpContext;

describe('every chat assistant tool declares its permission', () => {
  // the report tools describe the registered queries, so the boot's order is kept
  registerReportQueries();
  provideReportPorts();
  provideChatTools(CHAT_PROVIDED_TOOLS);
  const toolsets = {
    project: () => buildProjectToolset(ctx),
    record: () => buildRecordToolset(ctx),
    ba: () =>
      buildBaToolset(ctx, {
        projectId: PROJECT,
        requirementId: '00000000-0000-4000-8000-000000000003',
      }),
    baFirstRequirements: () =>
      buildBaFirstRequirementsToolset(ctx, { projectId: PROJECT, onboardingId: 'o' }),
    requirementDraft: () => buildRequirementDraftToolset(ctx, PROJECT),
  };

  for (const [name, build] of Object.entries(toolsets)) {
    it(`the ${name} toolset is served whole`, () => {
      expect(build().tools.length).toBeGreaterThan(0);
    });
  }

  it('refuses a toolset holding a tool that declares no permission, naming it', () => {
    const undeclared = () => ({
      name: 'forge_planted',
      description: 'planted',
      reach: 'project' as const,
      grant: 'projects:read' as const,
      route: '/api/projects' as const,
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({}),
    });
    expect(() => buildToolset(ctx, [{ factory: undeclared }])).toThrow(
      /tool forge_planted is not served: forge_planted declares no permission/,
    );
  });

  it('refuses an action the chat serves with no declaration, and not one it does not serve', () => {
    const partly = () => ({
      name: 'forge_partly',
      description: 'partly declared',
      reach: 'project' as const,
      grant: 'projects:read' as const,
      route: '/api/projects' as const,
      permission: { byAction: { get: onArg('project.read') } },
      inputSchema: {
        type: 'object',
        properties: { action: { type: 'string', enum: ['get', 'set'] } },
      },
      handler: async () => ({}),
    });
    expect(() => buildToolset(ctx, [{ factory: partly }])).toThrow(
      /forge_partly\.set declares no permission/,
    );
    expect(() => buildToolset(ctx, [{ factory: partly, allowedActions: ['get'] }])).not.toThrow();
  });
});
