const flagDefs = {
  // v1 EPIC 4 — Comment mentions + notification fan-out (PR-B)
  commentMentions: true,

  // v1 EPIC 4 — User preferences + storage adapter (PR-C)
  userPreferences: true,

  knowledgeOps: true,

  // v1 EPIC 5 — WebhookSource adapter framework (replaces inline GitHub branch)
  webhookAdapter: true,

  skillUi: true,

  socialAuth: true,
} as const;

type FeatureFlag = keyof typeof flagDefs;

function readEnv(flag: FeatureFlag): boolean {
  const envKey = `FEATURE_${flag.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`;
  const v = process.env[envKey];
  if (v === undefined) return flagDefs[flag];
  return v === 'true' || v === '1';
}

export function isEnabled(flag: FeatureFlag): boolean {
  return readEnv(flag);
}
