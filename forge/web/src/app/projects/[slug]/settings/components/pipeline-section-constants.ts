export const STEPS = [
  { key: 'autoTriage', label: 'Triage', desc: 'Validate completeness, classify complexity, set category/priority', status: 'open → confirmed' },
  { key: 'autoPlan', label: 'Plan', desc: 'Explore codebase, write implementation plan', status: 'confirmed → approved / waiting' },
  { key: 'autoCode', label: 'Code', desc: 'Create branch, implement, build, push', status: 'approved → developed' },
  { key: 'autoReview', label: 'Review', desc: 'Independent code review, post findings', status: 'developed → deploying / reopen' },
  { key: 'autoTest', label: 'QA Test', desc: 'Test against staging deployment', status: 'testing → tested / pass' },
  { key: 'autoFix', label: 'Fix', desc: 'Read rejection feedback, apply scoped fix', status: 'reopen → developed' },
  { key: 'autoRelease', label: 'Release', desc: 'Squash merge to production branch, trigger deploy', status: 'released → closed' },
] as const;

export const RUNNERS = [
  { value: 'desktop', label: 'Desktop (Claude CLI)' },
  { value: 'antigravity', label: 'Antigravity' },
] as const;

export const ANTIGRAVITY_MODELS = [
  { value: '', label: 'Default' },
  { value: 'Gemini 3.1 Pro (High)', label: 'Gemini 3.1 Pro (High)' },
  { value: 'Gemini 3.1 Pro (Low)', label: 'Gemini 3.1 Pro (Low)' },
  { value: 'Gemini 3 Flash', label: 'Gemini 3 Flash' },
  { value: 'Claude Sonnet 4.6 (Thinking)', label: 'Claude Sonnet 4.6 (Thinking)' },
  { value: 'Claude Opus 4.6 (Thinking)', label: 'Claude Opus 4.6 (Thinking)' },
] as const;

export interface StepConfig {
  enabled: boolean;
  runner: 'desktop' | 'antigravity';
  model?: string;
}

export interface CustomPipelineStep {
  status: string;
  skill: string;
  runner: 'desktop' | 'antigravity';
  model?: string;
  skip?: { field: string; op: 'eq' | 'neq' | 'in' | 'notIn'; value: string | string[] };
  nextStatus?: string;
}

export const SKIP_FIELDS = ['complexity', 'category', 'priority'] as const;
export const SKIP_OPS = [
  { value: 'eq', label: '=' },
  { value: 'neq', label: '≠' },
  { value: 'in', label: 'in' },
  { value: 'notIn', label: 'not in' },
] as const;

export const PIPELINE_STATUSES = [
  'open', 'confirmed', 'waiting', 'approved', 'developed',
  'deploying', 'testing', 'tested', 'pass', 'reopen', 'released',
] as const;

export const PIPELINE_SKILLS = [
  'forge-triage', 'forge-clarify', 'forge-plan', 'forge-code',
  'forge-review', 'forge-test', 'forge-fix', 'forge-release',
] as const;

export interface TestCredential {
  label: string;
  username: string;
  password: string;
}

export interface TestingUrl {
  label: string;
  url: string;
}

export interface PipelineSectionProps {
  projectDocumentId: string;
  pipelineEnabled: boolean;
  setPipelineEnabled: (v: boolean) => void;
  pipelineSteps: Record<string, StepConfig>;
  setPipelineSteps: (v: Record<string, StepConfig>) => void;
  customPipelineSteps: CustomPipelineStep[];
  setCustomPipelineSteps: (v: CustomPipelineStep[]) => void;
  useCustomPipeline: boolean;
  setUseCustomPipeline: (v: boolean) => void;
  antigravityConnected: boolean;
  testingUrls: TestingUrl[];
  setTestingUrls: (v: TestingUrl[]) => void;
  testCredentials: TestCredential[];
  setTestCredentials: (v: TestCredential[]) => void;
  heartbeatEnabled: boolean;
  setHeartbeatEnabled: (v: boolean) => void;
  heartbeatPaused: boolean;
  setHeartbeatPaused: (v: boolean) => void;
  heartbeatInterval: number;
  setHeartbeatInterval: (v: number) => void;
}
