/**
 * Antigravity Proxy Client
 *
 * Core communication with the Antigravity agent service proxy.
 * Handles chat (sync/async), project CRUD, and agent listing.
 */

import type {
    ChatRequest,
    ChatResponse,
    AsyncChatResponse,
    ChatStatusResponse,
    ProjectListResponse,
    AgentInfo,
} from './types';

const DEFAULT_PROXY_URL = 'https://canawan.cleverbee.me/api/remoteai';

/** Resolve the proxy URL from env or default. */
function resolveProxyUrl(): string {
    return process.env.ANTIGRAVITY_PROXY_URL || DEFAULT_PROXY_URL;
}

/**
 * Send a synchronous chat message to an Antigravity project.
 * Blocks until the agent responds or times out.
 */
export async function chat(req: ChatRequest): Promise<ChatResponse> {
    const url = resolveProxyUrl();
    const res = await fetch(`${url}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, sync: true, timeoutSeconds: req.timeoutSeconds || 1800 }),
    });
    if (!res.ok) {
        throw new Error(`Antigravity chat failed: ${res.status} ${await res.text()}`);
    }
    return res.json() as Promise<ChatResponse>;
}

/**
 * Send an async chat message. Returns a requestId for polling.
 */
export async function chatAsync(req: Omit<ChatRequest, 'sync'>): Promise<AsyncChatResponse> {
    if (!req.projectId) throw new Error('Antigravity chatAsync: projectId is required');
    if (!req.message) throw new Error('Antigravity chatAsync: message is required');

    const url = resolveProxyUrl();
    const res = await fetch(`${url}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...req, sync: false, timeoutSeconds: req.timeoutSeconds || 1800 }),
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Antigravity chat failed: ${res.status} ${body} (projectId=${req.projectId}, model=${req.model || 'default'})`);
    }
    return res.json() as Promise<AsyncChatResponse>;
}

/**
 * Poll for async chat result.
 */
export async function chatStatus(requestId: string): Promise<ChatStatusResponse> {
    const url = resolveProxyUrl();
    const res = await fetch(`${url}/chat/status/${encodeURIComponent(requestId)}`);
    if (!res.ok) {
        throw new Error(`Antigravity status check failed: ${res.status}`);
    }
    return res.json() as Promise<ChatStatusResponse>;
}

/**
 * List all Antigravity projects.
 */
export async function listProjects(): Promise<ProjectListResponse> {
    const url = resolveProxyUrl();
    const res = await fetch(`${url}/projects`);
    if (!res.ok) {
        throw new Error(`Antigravity list projects failed: ${res.status}`);
    }
    return res.json() as Promise<ProjectListResponse>;
}

/**
 * List all agents (runners) behind the proxy.
 * New proxy API — returns agent status, capacity, and project count.
 */
export async function listAgents(): Promise<AgentInfo[]> {
    const url = resolveProxyUrl();
    const res = await fetch(`${url}/agents`);
    if (!res.ok) {
        throw new Error(`Antigravity list agents failed: ${res.status}`);
    }
    return res.json() as Promise<AgentInfo[]>;
}

/**
 * Create a new Antigravity project with a config file.
 * @param agentId — routes the project to a specific agent (new proxy API).
 */
export async function createProject(configFile?: Buffer, filename?: string, agentId?: string): Promise<any> {
    const url = resolveProxyUrl();
    const form = new FormData();
    if (configFile) {
        form.append('configFile', new Blob([configFile]), filename || 'config.json');
    }
    const params = agentId ? `?agentId=${encodeURIComponent(agentId)}` : '';
    const res = await fetch(`${url}/createProject${params}`, {
        method: 'POST',
        body: form,
    });
    if (!res.ok) {
        throw new Error(`Antigravity create project failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
}

/**
 * Upload/replace config for an existing Antigravity project.
 */
export async function uploadProjectConfig(
    projectId: string,
    configFile: Buffer,
    filename?: string,
    deleteOldFiles = true,
): Promise<any> {
    const url = resolveProxyUrl();
    const form = new FormData();
    form.append('configFile', new Blob([configFile]), filename || 'config.json');
    const params = new URLSearchParams({
        projectId,
        deleteOldFiles: String(deleteOldFiles),
    });
    const res = await fetch(`${url}/uploadProjectConfig?${params}`, {
        method: 'POST',
        body: form,
    });
    if (!res.ok) {
        throw new Error(`Antigravity upload config failed: ${res.status} ${await res.text()}`);
    }
    return res.json();
}

/**
 * Delete an Antigravity project.
 */
export async function deleteProject(projectId: string): Promise<void> {
    const url = resolveProxyUrl();
    const params = new URLSearchParams({ projectId });
    const res = await fetch(`${url}/deleteProject?${params}`, { method: 'DELETE' });
    if (!res.ok) {
        throw new Error(`Antigravity delete project failed: ${res.status}`);
    }
}
