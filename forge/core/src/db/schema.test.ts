import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  devicePlatforms,
  deviceStatuses,
  devices,
  emailVerificationTokens,
  jobEventKinds,
  jobEvents,
  jobStatuses,
  jobTypes,
  jobs,
  modelTiers,
  pairingCodes,
  projectMemberRoles,
  projectMembers,
  projects,
  projectsRelations,
  refreshTokens,
  users,
} from './schema.js';

type AnyTable =
  | typeof users
  | typeof emailVerificationTokens
  | typeof projects
  | typeof projectMembers
  | typeof refreshTokens
  | typeof devices
  | typeof pairingCodes
  | typeof jobs
  | typeof jobEvents;

function columnByName(table: AnyTable, name: string) {
  const cfg = getTableConfig(table);
  const col = cfg.columns.find((c) => c.name === name);
  if (!col) throw new Error(`column ${name} not found`);
  return col;
}

function withTimezone(col: unknown): boolean | undefined {
  return (col as { config?: { withTimezone?: boolean } }).config?.withTimezone;
}

describe('db/schema — users', () => {
  it('has the five documented columns', () => {
    const names = getTableConfig(users).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['created_at', 'email', 'email_verified_at', 'id', 'password_hash'].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(users, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('email is notNull and unique', () => {
    const email = columnByName(users, 'email');
    expect(email.notNull).toBe(true);
    expect(email.isUnique).toBe(true);
  });

  it('password_hash is notNull', () => {
    expect(columnByName(users, 'password_hash').notNull).toBe(true);
  });

  it('email_verified_at is nullable timestamptz with no default', () => {
    const c = columnByName(users, 'email_verified_at');
    expect(c.notNull).toBe(false);
    expect(c.hasDefault).toBe(false);
    expect(withTimezone(c)).toBe(true);
  });

  it('created_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(users, 'created_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });
});

describe('db/schema — email_verification_tokens', () => {
  it('has the four documented columns', () => {
    const names = getTableConfig(emailVerificationTokens).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['created_at', 'expires_at', 'token', 'user_id'].sort());
  });

  it('token is the primary key', () => {
    expect(columnByName(emailVerificationTokens, 'token').primary).toBe(true);
  });

  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(emailVerificationTokens);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('user_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });

  it('has an index on user_id', () => {
    const cfg = getTableConfig(emailVerificationTokens);
    expect(cfg.indexes.some((i) => i.config.name === 'email_verification_tokens_user_id_idx')).toBe(
      true,
    );
  });

  it('expires_at and created_at are timestamptz', () => {
    for (const name of ['expires_at', 'created_at']) {
      const c = columnByName(emailVerificationTokens, name);
      expect(c.notNull).toBe(true);
      expect(withTimezone(c)).toBe(true);
    }
  });
});

describe('db/schema — projects', () => {
  it('has the seven documented columns', () => {
    const names = getTableConfig(projects).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['agent_config', 'created_at', 'id', 'name', 'owner_id', 'slug', 'webhook_secret'].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(projects, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('slug is notNull and unique', () => {
    const slug = columnByName(projects, 'slug');
    expect(slug.notNull).toBe(true);
    expect(slug.isUnique).toBe(true);
  });

  it('name is notNull', () => {
    expect(columnByName(projects, 'name').notNull).toBe(true);
  });

  it('agent_config is nullable jsonb', () => {
    const c = columnByName(projects, 'agent_config');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgJsonb');
  });

  it('webhook_secret is nullable text', () => {
    const c = columnByName(projects, 'webhook_secret');
    expect(c.notNull).toBe(false);
  });

  it('created_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(projects, 'created_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('owner_id references users.id with onDelete restrict', () => {
    const cfg = getTableConfig(projects);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('owner_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('restrict');
  });

  it('has a named index on owner_id', () => {
    const cfg = getTableConfig(projects);
    expect(cfg.indexes.some((i) => i.config.name === 'projects_owner_id_idx')).toBe(true);
  });

  it('projectsRelations targets the projects table', () => {
    expect(projectsRelations.table).toBe(projects);
  });
});

describe('db/schema — project_members', () => {
  it('has the four documented columns', () => {
    const names = getTableConfig(projectMembers).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['created_at', 'project_id', 'role', 'user_id'].sort());
  });

  it('has composite primary key over [user_id, project_id]', () => {
    const cfg = getTableConfig(projectMembers);
    expect(cfg.primaryKeys).toHaveLength(1);
    const pk = cfg.primaryKeys[0];
    if (!pk) throw new Error('expected composite PK');
    const pkCols = pk.columns.map((c) => c.name);
    expect(pkCols).toEqual(['user_id', 'project_id']);
  });

  it('user_id FK cascades, project_id FK cascades', () => {
    const cfg = getTableConfig(projectMembers);
    expect(cfg.foreignKeys).toHaveLength(2);
    for (const fk of cfg.foreignKeys) {
      expect(fk.onDelete).toBe('cascade');
    }
  });

  it('role defaults to member and enum matches projectMemberRoles', () => {
    const role = columnByName(projectMembers, 'role');
    expect(role.notNull).toBe(true);
    expect(role.hasDefault).toBe(true);
    expect(role.default).toBe('member');
    expect(role.enumValues).toEqual([...projectMemberRoles]);
  });

  it('projectMemberRoles exports the expected values', () => {
    expect(projectMemberRoles).toEqual(['owner', 'admin', 'member']);
  });

  it('has a named index on project_id', () => {
    const cfg = getTableConfig(projectMembers);
    expect(cfg.indexes.some((i) => i.config.name === 'project_members_project_id_idx')).toBe(true);
  });

  it('created_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(projectMembers, 'created_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });
});

describe('db/schema — refresh_tokens', () => {
  it('has the seven documented columns', () => {
    const names = getTableConfig(refreshTokens).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      ['created_at', 'expires_at', 'id', 'token_hash', 'token_prefix', 'used_at', 'user_id'].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(refreshTokens, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(refreshTokens);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('user_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });

  it('token_prefix and token_hash are notNull text', () => {
    for (const name of ['token_prefix', 'token_hash']) {
      expect(columnByName(refreshTokens, name).notNull).toBe(true);
    }
  });

  it('expires_at is notNull timestamptz', () => {
    const c = columnByName(refreshTokens, 'expires_at');
    expect(c.notNull).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('used_at is nullable timestamptz', () => {
    const c = columnByName(refreshTokens, 'used_at');
    expect(c.notNull).toBe(false);
    expect(withTimezone(c)).toBe(true);
  });

  it('has composite index on (user_id, used_at) and index on token_prefix', () => {
    const cfg = getTableConfig(refreshTokens);
    expect(cfg.indexes.some((i) => i.config.name === 'refresh_tokens_user_id_used_at_idx')).toBe(
      true,
    );
    expect(cfg.indexes.some((i) => i.config.name === 'refresh_tokens_token_prefix_idx')).toBe(true);
  });
});

describe('db/schema — devices', () => {
  it('exports the platform and status enum values', () => {
    expect(devicePlatforms).toEqual(['macos', 'linux', 'windows']);
    expect(deviceStatuses).toEqual(['online', 'offline', 'revoked']);
  });

  it('has the twelve documented columns', () => {
    const names = getTableConfig(devices).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      [
        'agent_version',
        'capabilities',
        'created_at',
        'id',
        'last_seen_at',
        'name',
        'owner_id',
        'paired_at',
        'platform',
        'status',
        'token_hash',
        'token_prefix',
      ].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(devices, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('owner_id references users.id with onDelete restrict', () => {
    const cfg = getTableConfig(devices);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('owner_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('restrict');
  });

  it('token_prefix is notNull varchar(8)', () => {
    const c = columnByName(devices, 'token_prefix');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgVarchar');
    expect((c as unknown as { length?: number }).length).toBe(8);
  });

  it('status defaults to offline and enum matches deviceStatuses', () => {
    const s = columnByName(devices, 'status');
    expect(s.notNull).toBe(true);
    expect(s.hasDefault).toBe(true);
    expect(s.default).toBe('offline');
    expect(s.enumValues).toEqual([...deviceStatuses]);
  });

  it('platform enum matches devicePlatforms', () => {
    const p = columnByName(devices, 'platform');
    expect(p.notNull).toBe(true);
    expect(p.enumValues).toEqual([...devicePlatforms]);
  });

  it('last_seen_at is nullable timestamptz', () => {
    const c = columnByName(devices, 'last_seen_at');
    expect(c.notNull).toBe(false);
    expect(withTimezone(c)).toBe(true);
  });

  it('paired_at is notNull timestamptz with defaultNow', () => {
    const c = columnByName(devices, 'paired_at');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('capabilities is nullable jsonb', () => {
    const c = columnByName(devices, 'capabilities');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgJsonb');
  });

  it('has named indexes on owner_id and token_prefix', () => {
    const cfg = getTableConfig(devices);
    expect(cfg.indexes.some((i) => i.config.name === 'devices_owner_id_idx')).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'devices_token_prefix_idx')).toBe(true);
  });
});

describe('db/schema — pairing_codes', () => {
  it('has the five documented columns', () => {
    const names = getTableConfig(pairingCodes).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['code', 'created_at', 'expires_at', 'used_at', 'user_id'].sort());
  });

  it('code is the primary key', () => {
    expect(columnByName(pairingCodes, 'code').primary).toBe(true);
  });

  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(pairingCodes);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('user_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });

  it('expires_at is notNull timestamptz, used_at is nullable', () => {
    const exp = columnByName(pairingCodes, 'expires_at');
    expect(exp.notNull).toBe(true);
    expect(withTimezone(exp)).toBe(true);
    const used = columnByName(pairingCodes, 'used_at');
    expect(used.notNull).toBe(false);
    expect(withTimezone(used)).toBe(true);
  });

  it('has named indexes on user_id and expires_at', () => {
    const cfg = getTableConfig(pairingCodes);
    expect(cfg.indexes.some((i) => i.config.name === 'pairing_codes_user_id_idx')).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'pairing_codes_expires_at_idx')).toBe(true);
  });
});

describe('db/schema — jobs', () => {
  it('exports the status, type, and model tier enum values', () => {
    expect(jobStatuses).toEqual(['queued', 'dispatched', 'running', 'done', 'failed', 'cancelled']);
    expect(jobTypes).toEqual([
      'triage',
      'clarify',
      'plan',
      'code',
      'review',
      'test',
      'release',
      'fix',
      'custom',
    ]);
    expect(modelTiers).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('has the sixteen documented columns', () => {
    const names = getTableConfig(jobs).columns.map((c) => c.name);
    expect(names.sort()).toEqual(
      [
        'created_at',
        'created_by',
        'device_id',
        'dispatched_at',
        'error',
        'exit_code',
        'finished_at',
        'id',
        'issue_id',
        'model_tier',
        'payload',
        'project_id',
        'queued_at',
        'started_at',
        'status',
        'type',
      ].sort(),
    );
  });

  it('id is uuid PK with defaultRandom', () => {
    const id = columnByName(jobs, 'id');
    expect(id.primary).toBe(true);
    expect(id.hasDefault).toBe(true);
    expect(id.columnType).toBe('PgUUID');
  });

  it('project_id cascades, device_id set null, created_by restricts', () => {
    const cfg = getTableConfig(jobs);
    expect(cfg.foreignKeys).toHaveLength(3);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('device_id')?.onDelete).toBe('set null');
    expect(byCol.get('created_by')?.onDelete).toBe('restrict');
  });

  it('issue_id is nullable uuid with no FK (Phase 2.3 will add)', () => {
    const c = columnByName(jobs, 'issue_id');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgUUID');
  });

  it('status defaults to queued and enum matches jobStatuses', () => {
    const s = columnByName(jobs, 'status');
    expect(s.notNull).toBe(true);
    expect(s.hasDefault).toBe(true);
    expect(s.default).toBe('queued');
    expect(s.enumValues).toEqual([...jobStatuses]);
  });

  it('type enum matches jobTypes', () => {
    const t = columnByName(jobs, 'type');
    expect(t.notNull).toBe(true);
    expect(t.enumValues).toEqual([...jobTypes]);
  });

  it('model_tier is nullable with modelTiers enum', () => {
    const m = columnByName(jobs, 'model_tier');
    expect(m.notNull).toBe(false);
    expect(m.enumValues).toEqual([...modelTiers]);
  });

  it('payload is notNull jsonb with default', () => {
    const c = columnByName(jobs, 'payload');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgJsonb');
    expect(c.hasDefault).toBe(true);
  });

  it('exit_code is nullable integer', () => {
    const c = columnByName(jobs, 'exit_code');
    expect(c.notNull).toBe(false);
    expect(c.columnType).toBe('PgInteger');
  });

  it('lifecycle timestamps: queued_at notNull+default, others nullable', () => {
    const q = columnByName(jobs, 'queued_at');
    expect(q.notNull).toBe(true);
    expect(q.hasDefault).toBe(true);
    expect(withTimezone(q)).toBe(true);
    for (const name of ['dispatched_at', 'started_at', 'finished_at']) {
      const c = columnByName(jobs, name);
      expect(c.notNull).toBe(false);
      expect(withTimezone(c)).toBe(true);
    }
  });

  it('has named indexes on project_id, device_id, issue_id, status', () => {
    const cfg = getTableConfig(jobs);
    for (const name of [
      'jobs_project_id_idx',
      'jobs_device_id_idx',
      'jobs_issue_id_idx',
      'jobs_status_idx',
    ]) {
      expect(cfg.indexes.some((i) => i.config.name === name)).toBe(true);
    }
  });
});

describe('db/schema — job_events', () => {
  it('exports the kind enum values', () => {
    expect(jobEventKinds).toEqual([
      'stdout',
      'stderr',
      'tool_call',
      'tool_result',
      'progress',
      'result',
    ]);
  });

  it('has the six documented columns', () => {
    const names = getTableConfig(jobEvents).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['data', 'id', 'job_id', 'kind', 'seq', 'ts'].sort());
  });

  it('job_id references jobs.id with onDelete cascade', () => {
    const cfg = getTableConfig(jobEvents);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('job_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });

  it('kind enum matches jobEventKinds', () => {
    const k = columnByName(jobEvents, 'kind');
    expect(k.notNull).toBe(true);
    expect(k.enumValues).toEqual([...jobEventKinds]);
  });

  it('seq is notNull integer', () => {
    const s = columnByName(jobEvents, 'seq');
    expect(s.notNull).toBe(true);
    expect(s.columnType).toBe('PgInteger');
  });

  it('ts is notNull timestamptz with defaultNow', () => {
    const c = columnByName(jobEvents, 'ts');
    expect(c.notNull).toBe(true);
    expect(c.hasDefault).toBe(true);
    expect(withTimezone(c)).toBe(true);
  });

  it('data is notNull jsonb with default', () => {
    const c = columnByName(jobEvents, 'data');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgJsonb');
    expect(c.hasDefault).toBe(true);
  });

  it('has unique composite index on (job_id, seq) for monotonic ordering', () => {
    const cfg = getTableConfig(jobEvents);
    const idx = cfg.indexes.find((i) => i.config.name === 'job_events_job_id_seq_idx');
    if (!idx) throw new Error('expected job_events_job_id_seq_idx');
    expect(idx.config.unique).toBe(true);
    expect(idx.config.columns.map((c) => (c as { name?: string }).name)).toEqual(['job_id', 'seq']);
  });

  it('has index on ts for retention sweeper', () => {
    const cfg = getTableConfig(jobEvents);
    expect(cfg.indexes.some((i) => i.config.name === 'job_events_ts_idx')).toBe(true);
  });
});
