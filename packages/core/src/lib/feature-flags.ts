const flagDefs = {
  pipelineControl: true,

  // v1 EPIC 4 — Comment mentions + notification fan-out (PR-B)
  commentMentions: true,

  // v1 EPIC 4 — User preferences + storage adapter (PR-C)
  userPreferences: true,

  knowledgeOps: true,

  // v1 EPIC 5 — WebhookSource adapter framework (replaces inline GitHub branch)
  webhookAdapter: true,

  skillUi: true,

  socialAuth: true,

  pmAgent: true,

  runnerGitCredProvision: false,
} as const;

export type FeatureFlag = keyof typeof flagDefs;

function readEnv(flag: FeatureFlag): boolean {
  const envKey = `FEATURE_${flag.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
  const v = process.env[envKey];
  if (v === undefined) return flagDefs[flag];
  return v === 'true' || v === '1';
}

export function isEnabled(flag: FeatureFlag): boolean {
  return readEnv(flag);
}

/** Snapshot of all flag values right now — for `/api/admin/health` or debug. */
export function snapshotFlags(): Record<FeatureFlag, boolean> {
  const out = {} as Record<FeatureFlag, boolean>;
  for (const k of Object.keys(flagDefs) as FeatureFlag[]) {
    out[k] = readEnv(k);
  }
  return out;
}
