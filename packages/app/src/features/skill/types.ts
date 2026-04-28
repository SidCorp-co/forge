export interface Skill {
  id: number;
  documentId: string;
  name: string;
  description: string;
  version: string;
  skillMd: string;
  files: SkillFile[];
  isGlobal: boolean;
  target: 'dev' | 'cloud' | 'all';
  contentHash: string | null;
  changelog: ChangelogEntry[];
  localGuide: string | null;
  project?: { documentId: string };
  createdAt: string;
  updatedAt: string;
}

export interface SkillFile {
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
}

export interface ChangelogEntry {
  version: string;
  hash: string;
  timestamp: string;
  summary: string;
}

export interface SkillSyncStatus {
  skillName: string;
  currentHash: string | null;
  currentVersion: string;
  target: string;
  isGlobal: boolean;
  updatedAt: string;
  devices: Array<{
    deviceId: string;
    inSync: boolean;
  }>;
}

export interface BulkPushResult {
  target: string;
  pushed: string[];
  skipped: string[];
  errors: string[];
}
