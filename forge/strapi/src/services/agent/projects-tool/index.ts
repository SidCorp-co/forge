import type { ForgeTool } from '../tools';
import { handleList, handleGet, handleCreate, handleUpdate } from './crud-actions';
import { handleGetApiKey, handleRegisterDevice, handleListDevices } from './device-actions';
import { handleBootstrap } from './bootstrap-action';
import {
  handleAntigravityList,
  handleAntigravityListAgents,
  handleAntigravityCreate,
  handleAntigravityConnect,
  handleAntigravityExcludeInclude,
} from './antigravity-actions';

export const forgeProjects: ForgeTool = {
  name: 'forge_projects',
  description: 'Project CRUD + Antigravity management. Actions: list, get, create, update, get_api_key, register_device, list_devices, bootstrap, antigravity_list, antigravity_list_agents, antigravity_create, antigravity_connect, antigravity_exclude, antigravity_include.',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'get', 'create', 'update', 'get_api_key', 'register_device', 'list_devices', 'bootstrap', 'antigravity_list', 'antigravity_list_agents', 'antigravity_create', 'antigravity_connect', 'antigravity_exclude', 'antigravity_include'] },
      targetProjectSlug: { type: 'string', description: 'Optional: access a project by slug (for get action)' },
      slug: { type: 'string', description: 'Project slug (for get action)' },
      documentId: { type: 'string', description: 'Project documentId (for get/update actions)' },
      data: {
        type: 'object',
        description: 'For create/update actions',
        properties: {
          name: { type: 'string' },
          slug: { type: 'string' },
          description: { type: 'string' },
          crossProjectAccess: { type: 'boolean' },
          projectMeta: { type: 'object', description: 'JSON metadata (stack, capabilities, exposes)' },
          agentConfig: { type: 'object', description: 'Agent configuration' },
          owner: { type: 'string', description: 'Owner user documentId or username' },
          members: { type: 'array', items: { type: 'string' }, description: 'Member user documentIds or usernames' },
          deviceId: { type: 'string', description: 'Existing device ID string to connect (use list_devices to find)' },
          deviceDocumentId: { type: 'string', description: 'Existing device documentId to connect (use list_devices to find)' },
          antigravityProjectId: { type: 'string', description: 'Antigravity project ID (for antigravity_connect action)' },
          agentId: { type: 'string', description: 'Route to a specific Antigravity agent (for antigravity_create action)' },
          configFile: { type: 'string', description: 'Base64-encoded config JSON file (for antigravity_create action)' },
          createAntigravity: { type: 'boolean', description: 'Also create and connect an Antigravity project (for bootstrap action)' },
          runnerId: { type: 'string', description: 'Runner documentId (for antigravity_exclude/antigravity_include actions)' },
        },
      },
    },
    required: ['action'],
  },
  async execute(input, ctx) {
    const action = input.action as string;

    switch (action) {
      case 'list':
        return handleList(input, ctx);
      case 'get':
        return handleGet(input, ctx);
      case 'create':
        return handleCreate(input, ctx);
      case 'update':
        return handleUpdate(input, ctx);
      case 'get_api_key':
        return handleGetApiKey(input, ctx);
      case 'register_device':
        return handleRegisterDevice(input, ctx);
      case 'list_devices':
        return handleListDevices(input, ctx);
      case 'bootstrap':
        return handleBootstrap(input, ctx);
      case 'antigravity_list':
        return handleAntigravityList();
      case 'antigravity_list_agents':
        return handleAntigravityListAgents();
      case 'antigravity_create':
        return handleAntigravityCreate(input, ctx);
      case 'antigravity_connect':
        return handleAntigravityConnect(input, ctx);
      case 'antigravity_exclude':
      case 'antigravity_include':
        return handleAntigravityExcludeInclude(input, ctx, action);
      default:
        return `Unknown action: ${action}`;
    }
  },
};
