/**
 * Antigravity shared type definitions.
 */

export interface ChatRequest {
    projectId: string;
    message: string;
    timeoutSeconds?: number;
    sync?: boolean;
    model?: string;
    newSession?: boolean;
}

export interface ChatResponse {
    sessionId: string;
    response: string;
    elapsedSeconds: number;
    timedOut: boolean;
}

export interface AsyncChatResponse {
    requestId: string;
}

export interface ChatStatusResponse {
    requestId: string;
    projectId: string;
    status: 'Pending' | 'Running' | 'Completed' | 'Failed' | string;
    createdAtUtc: string | null;
    startedAtUtc: string | null;
    completedAtUtc: string | null;
    result: {
        projectId: string;
        response: string;
        elapsedSeconds: number;
        timedOut: boolean;
    } | null;
    error: string | null;
}

export interface ProjectListResponse {
    total: number;
    /** New proxy format — array of objects with agentId. */
    projects?: Array<{ projectId: string; agentId: string }>;
    /** Legacy format — flat array of IDs (single-instance). */
    projectIds?: string[];
}

export interface AgentInfo {
    agentId: string;
    agentType: string;
    status: 'Online' | 'Offline' | string;
    projectCount: number;
    maxProjects: number;
    offlineSince: string | null;
}

export interface ModelUsage {
    model: string;
    refreshLabel: string;
    segments: number[];
    /** Average of segments — 100 = all remaining, 0 = depleted */
    remaining: number;
    /** Bar color from Antigravity UI: 'full' (bg-foreground, healthy) | 'warning' (bg-yellow-400, low) */
    status: 'full' | 'warning' | 'empty';
}
