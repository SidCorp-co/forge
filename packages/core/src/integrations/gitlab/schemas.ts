import { z } from 'zod';
import { RELEASE_CHANNEL_KEYS, releaseChannelFields } from '../index.js';

/** `group/sub/project`: at least two segments, GitLab's own path characters. */
const GITLAB_PROJECT_PATH = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(\/[A-Za-z0-9_.][A-Za-z0-9_.-]*)+$/;

export const gitlabConfigBase = z.object({
  baseUrl: z.string().url().max(500).optional(),
  projectPath: z.string().regex(GITLAB_PROJECT_PATH).max(500).optional(),
  projectId: z.number().int().positive().optional(),
  ...releaseChannelFields,
});

export const gitlabSecretsSchema = z.object({
  token: z.string().min(8).max(500),
});

export const GITLAB_BINDING_CONFIG_KEYS = [
  'projectPath',
  'projectId',
  ...RELEASE_CHANNEL_KEYS,
] as const;
