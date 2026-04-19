/**
 * Antigravity Service Client
 *
 * Communicates with the Antigravity agent service for server-side pipeline execution.
 * Each Forge project maps to an Antigravity project (1:1) via projectId stored in agentConfig.
 * Antigravity projects are configured with MCP access to Forge, so agents can call
 * forge_issues, forge_comments, etc. directly.
 *
 * Module structure:
 *   types.ts          — shared interfaces
 *   client.ts         — proxy API client (chat, projects, agents)
 *   usage.ts          — model usage/credits
 *   zip-utils.ts      — pure zip construction (CRC32, deflate, assembly)
 *   forge-cli-gen.ts  — generates baked-in forge-api.mjs CLI
 *   skills-zip.ts     — builds skills zip bundle
 *   response-parser.ts — cleans Antigravity response text
 *   sync.ts           — skills sync to Antigravity projects
 */

// Types
export type {
    ChatRequest,
    ChatResponse,
    AsyncChatResponse,
    ChatStatusResponse,
    ProjectListResponse,
    AgentInfo,
    ModelUsage,
} from './types';

// Client
export {
    chat,
    chatAsync,
    chatStatus,
    listProjects,
    listAgents,
    createProject,
    uploadProjectConfig,
    deleteProject,
} from './client';

// Usage
export { getUsage, getUsageByProject } from './usage';

// Zip utilities
export { crc32, deflateBuffer, zipEntry, assembleZip } from './zip-utils';

// Skills zip builder
export { buildSkillsZip } from './skills-zip';

// Forge CLI generator
export { generateForgeCli } from './forge-cli-gen';

// Response parser
export { parseAntigravityResponse } from './response-parser';

// Skills sync
export { syncSkills, syncSkillsToAll, needsSkillSync } from './sync';
