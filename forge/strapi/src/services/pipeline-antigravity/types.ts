export interface PipelineStepConfig {
    enabled?: boolean;
    runner?: 'desktop' | 'antigravity';
    model?: string;
}

export interface PipelineCondition {
    field: string;
    op: 'eq' | 'neq' | 'in' | 'notIn';
    value: string | string[];
}

export interface PipelineStep {
    status: string;
    skill: string;
    runner?: 'desktop' | 'antigravity';
    model?: string;
    skip?: PipelineCondition;
    nextStatus?: string;
}

export interface PipelineConfig {
    enabled: boolean;
    autoTriage?: boolean | PipelineStepConfig;
    autoClarify?: boolean | PipelineStepConfig;
    autoPlan?: boolean | PipelineStepConfig;
    autoCode?: boolean | PipelineStepConfig;
    autoReview?: boolean | PipelineStepConfig;
    autoTest?: boolean | PipelineStepConfig;
    autoFix?: boolean | PipelineStepConfig;
    autoCiFix?: boolean | { enabled: boolean; maxAttempts?: number };
    autoRelease?: boolean | PipelineStepConfig;
    pipelineSteps?: PipelineStep[];
}
