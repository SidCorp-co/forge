import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import {
  activityLog,
  actorTypes,
  comments,
  desktopPairingCodes,
  devicePlatforms,
  deviceStatuses,
  devices,
  emailVerificationTokens,
  feedbackReports,
  issueDependencies,
  issueDependencyKinds,
  issueLabels,
  issuePriorities,
  issueStatuses,
  issues,
  jobEventKinds,
  jobEvents,
  jobStatuses,
  jobs,
  jobTypes,
  labels,
  memorySources,
  modelTiers,
  notificationTypes,
  pairingCodes,
  pmConfig,
  pmDecisions,
  pmPolicies,
  projectInvitations,
  projectIssCounters,
  projectMemberRoles,
  projectMembers,
  projects,
  projectsRelations,
  promptBlobs,
  refreshTokens,
  tasks,
  type users,
} from './schema.js';

type AnyTable =
  | typeof users
  | typeof emailVerificationTokens
  | typeof projects
  | typeof projectMembers
  | typeof refreshTokens
  | typeof devices
  | typeof pairingCodes
  | typeof desktopPairingCodes
  | typeof jobs
  | typeof jobEvents
  | typeof issues
  | typeof comments
  | typeof labels
  | typeof issueLabels
  | typeof activityLog
  | typeof projectIssCounters
  | typeof projectInvitations;

function columnByName(table: AnyTable, name: string) {
  const cfg = getTableConfig(table);
  const col = cfg.columns.find((c) => c.name === name);
  if (!col) throw new Error(`column ${name} not found`);
  return col;
}

function withTimezone(col: unknown): boolean | undefined {
  return (col as { config?: { withTimezone?: boolean } }).config?.withTimezone;
}

describe('db/schema — email_verification_tokens', () => {
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
});

describe('db/schema — projects', () => {
  it('org_id references organizations.id with onDelete restrict', () => {
    const cfg = getTableConfig(projects);
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === 'org_id');
    if (!fk) throw new Error('expected org_id FK');
    const ref = fk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('restrict');
  });

  it('created_by (audit-only) references users.id with onDelete restrict', () => {
    const cfg = getTableConfig(projects);
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === 'created_by');
    if (!fk) throw new Error('expected created_by FK');
    const ref = fk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('restrict');
  });

  it('default_device_id references devices.id with onDelete set null', () => {
    const cfg = getTableConfig(projects);
    const fk = cfg.foreignKeys.find((f) => f.reference().columns[0]?.name === 'default_device_id');
    if (!fk) throw new Error('expected default_device_id FK');
    const ref = fk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('set null');
  });

  it('projectsRelations targets the projects table', () => {
    expect(projectsRelations.table).toBe(projects);
  });
});

describe('db/schema — project_members', () => {
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
    expect(projectMemberRoles).toEqual(['admin', 'member', 'viewer']);
  });
});

describe('db/schema — refresh_tokens', () => {
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
});

describe('db/schema — devices', () => {
  it('exports the platform and status enum values', () => {
    expect(devicePlatforms).toEqual(['macos', 'linux', 'windows']);
    expect(deviceStatuses).toEqual(['online', 'offline', 'revoked']);
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
});

describe('db/schema — pairing_codes', () => {
  it('user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(pairingCodes);
    const userFk = cfg.foreignKeys.find((fk) => fk.reference().columns[0]?.name === 'user_id');
    if (!userFk) throw new Error('expected user_id FK');
    const ref = userFk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(userFk.onDelete).toBe('cascade');
  });

  it('project_id is nullable and references projects.id with onDelete cascade', () => {
    const cfg = getTableConfig(pairingCodes);
    const pid = columnByName(pairingCodes, 'project_id');
    expect(pid.notNull).toBe(false);
    const projFk = cfg.foreignKeys.find((fk) => fk.reference().columns[0]?.name === 'project_id');
    if (!projFk) throw new Error('expected project_id FK');
    const ref = projFk.reference();
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(projFk.onDelete).toBe('cascade');
  });
});

describe('db/schema — desktop_pairing_codes', () => {
  it('approved_user_id references users.id with onDelete cascade', () => {
    const cfg = getTableConfig(desktopPairingCodes);
    expect(cfg.foreignKeys).toHaveLength(1);
    const fk = cfg.foreignKeys[0];
    if (!fk) throw new Error('expected FK');
    const ref = fk.reference();
    expect(ref.columns[0]?.name).toBe('approved_user_id');
    expect(ref.foreignColumns[0]?.name).toBe('id');
    expect(fk.onDelete).toBe('cascade');
  });
});

describe('db/schema — jobs', () => {
  it('exports the status, type, and model tier enum values', () => {
    // cm:guard `held` sits between `running` and the terminal three ON PURPOSE (RFC 0002) — every predicate that splits this enum reads it positionally in review, so a `held` appended after `cancelled` would look terminal to the next reader even though nothing in code treats order as semantic
    expect(jobStatuses).toEqual([
      'queued',
      'dispatched',
      'running',
      'held',
      'done',
      'failed',
      'cancelled',
    ]);
    expect(jobTypes).toEqual([
      'triage',
      'clarify',
      'plan',
      'code',
      'review',
      'test',
      'staging',
      'release',
      'fix',
      'custom',
      'pm',
      'smoke',
      'release_batch',
      'reconcile',
      'verify_skill',
    ]);
    expect(modelTiers).toEqual(['haiku', 'sonnet', 'opus']);
  });

  it('project_id cascades, device_id/issue_id/retry_of/runner_id set null, created_by/pipeline_run_id restrict, system_prompt_hash references prompt_blobs', () => {
    const cfg = getTableConfig(jobs);
    expect(cfg.foreignKeys).toHaveLength(8);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('device_id')?.onDelete).toBe('set null');
    expect(byCol.get('created_by')?.onDelete).toBe('restrict');
    expect(byCol.get('issue_id')?.onDelete).toBe('set null');
    expect(byCol.get('retry_of')?.onDelete).toBe('set null');
    expect(byCol.get('runner_id')?.onDelete).toBe('set null');
    expect(byCol.get('pipeline_run_id')?.onDelete).toBe('restrict');
    // S1.1 — content-addressable system prompt blob.
    expect(byCol.get('system_prompt_hash')?.reference().foreignTable).toBe(promptBlobs);
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
      // ISS-442 C0 — audited manual intervention (single-job cancel).
      'intervention',
      'kill_ack',
    ]);
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

  it('has unique composite index on (job_id, seq) for monotonic ordering', () => {
    const cfg = getTableConfig(jobEvents);
    const idx = cfg.indexes.find((i) => i.config.name === 'job_events_job_id_seq_idx');
    if (!idx) throw new Error('expected job_events_job_id_seq_idx');
    expect(idx.config.unique).toBe(true);
    expect(idx.config.columns.map((c) => (c as { name?: string }).name)).toEqual(['job_id', 'seq']);
  });
});

describe('db/schema — issues', () => {
  it('exports the status and priority enum values', () => {
    expect(issueStatuses).toEqual([
      'open',
      'confirmed',
      'clarified',
      'waiting',
      'approved',
      'in_progress',
      'developed',
      'testing',
      'tested',
      'released',
      'closed',
      'reopen',
      'on_hold',
      'needs_info',
      'draft',
    ]);
    expect(issuePriorities).toEqual(['critical', 'high', 'medium', 'low', 'none']);
  });

  it('reopen_count is notNull integer with default 0 (F4 reopen-cap tracking)', () => {
    const c = columnByName(issues, 'reopen_count');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgInteger');
    expect(c.hasDefault).toBe(true);
    expect(c.default).toBe(0);
  });

  it('iss_seq is notNull integer with default 0 (trigger overwrites)', () => {
    const c = columnByName(issues, 'iss_seq');
    expect(c.notNull).toBe(true);
    expect(c.columnType).toBe('PgInteger');
    expect(c.hasDefault).toBe(true);
    expect(c.default).toBe(0);
  });

  it('status defaults to open and enum matches issueStatuses', () => {
    const s = columnByName(issues, 'status');
    expect(s.notNull).toBe(true);
    expect(s.default).toBe('open');
    expect(s.enumValues).toEqual([...issueStatuses]);
  });

  it('priority defaults to medium and enum matches issuePriorities', () => {
    const p = columnByName(issues, 'priority');
    expect(p.notNull).toBe(true);
    expect(p.default).toBe('medium');
    expect(p.enumValues).toEqual([...issuePriorities]);
  });

  it('FKs: project cascade, assignee set null, created_by restrict, parent self set null, release batch run set null', () => {
    const cfg = getTableConfig(issues);
    expect(cfg.foreignKeys).toHaveLength(5);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('assignee_id')?.onDelete).toBe('set null');
    expect(byCol.get('created_by_id')?.onDelete).toBe('restrict');
    expect(byCol.get('parent_issue_id')?.onDelete).toBe('set null');
    expect(byCol.get('parent_issue_id')?.reference().foreignTable).toBe(issues);
    expect(byCol.get('release_batch_run_id')?.onDelete).toBe('set null');
  });

  it('has unique index on (project_id, iss_seq) and named indexes', () => {
    const cfg = getTableConfig(issues);
    const uq = cfg.indexes.find((i) => i.config.name === 'issues_project_iss_seq_uq');
    if (!uq) throw new Error('expected issues_project_iss_seq_uq');
    expect(uq.config.unique).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'issues_project_status_idx')).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'issues_assignee_idx')).toBe(true);
  });
});

describe('db/schema — project_iss_counters', () => {
  it('has project_id PK and next_seq integer default 1', () => {
    const names = getTableConfig(projectIssCounters).columns.map((c) => c.name);
    expect(names.sort()).toEqual(['next_seq', 'project_id'].sort());
    expect(columnByName(projectIssCounters, 'project_id').primary).toBe(true);
    const seq = columnByName(projectIssCounters, 'next_seq');
    expect(seq.notNull).toBe(true);
    expect(seq.default).toBe(1);
  });

  it('project_id cascades on project delete', () => {
    const cfg = getTableConfig(projectIssCounters);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
  });
});

describe('db/schema — comments', () => {
  it('issue_id cascades, author_id restricts, author_device_id set null, parent_id cascades', () => {
    const cfg = getTableConfig(comments);
    expect(cfg.foreignKeys).toHaveLength(4);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('issue_id')?.onDelete).toBe('cascade');
    expect(byCol.get('author_id')?.onDelete).toBe('restrict');
    // ISS-519 — agent-author marker FK; de-marks rather than blocks on device delete.
    expect(byCol.get('author_device_id')?.onDelete).toBe('set null');
    expect(byCol.get('parent_id')?.onDelete).toBe('cascade');
  });

  it('has indexes on issue_id and parent_id', () => {
    const cfg = getTableConfig(comments);
    const names = cfg.indexes.map((i) => i.config.name);
    expect(names).toContain('comments_issue_id_idx');
    expect(names).toContain('comments_parent_id_idx');
  });
});

describe('db/schema — labels', () => {
  it('project_id cascades', () => {
    const cfg = getTableConfig(labels);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('has unique composite index on (project_id, name)', () => {
    const cfg = getTableConfig(labels);
    const idx = cfg.indexes.find((i) => i.config.name === 'labels_project_id_name_uq');
    if (!idx) throw new Error('expected labels_project_id_name_uq');
    expect(idx.config.unique).toBe(true);
  });
});

describe('db/schema — issue_labels', () => {
  it('has composite primary key over (issue_id, label_id)', () => {
    const cfg = getTableConfig(issueLabels);
    expect(cfg.primaryKeys).toHaveLength(1);
    const pk = cfg.primaryKeys[0];
    if (!pk) throw new Error('expected composite PK');
    expect(pk.columns.map((c) => c.name)).toEqual(['issue_id', 'label_id']);
  });

  it('both FKs cascade', () => {
    const cfg = getTableConfig(issueLabels);
    expect(cfg.foreignKeys).toHaveLength(2);
    for (const fk of cfg.foreignKeys) expect(fk.onDelete).toBe('cascade');
  });
});

describe('db/schema — project_invitations', () => {
  it('FKs: project cascades, inviter cascades', () => {
    const cfg = getTableConfig(projectInvitations);
    expect(cfg.foreignKeys).toHaveLength(2);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('inviter_id')?.onDelete).toBe('cascade');
  });

  it('role enum matches projectMemberRoles', () => {
    const r = columnByName(projectInvitations, 'role');
    expect(r.notNull).toBe(true);
    expect(r.enumValues).toEqual([...projectMemberRoles]);
  });

  it('has index on (project_id, email) and partial-unique on same with accepted_at IS NULL', () => {
    const cfg = getTableConfig(projectInvitations);
    expect(cfg.indexes.some((i) => i.config.name === 'project_invitations_project_email_idx')).toBe(
      true,
    );
    const uq = cfg.indexes.find(
      (i) => i.config.name === 'project_invitations_project_email_pending_uq',
    );
    if (!uq) throw new Error('expected partial-unique index');
    expect(uq.config.unique).toBe(true);
  });
});

describe('db/schema — activity_log', () => {
  it('exports the actor type enum', () => {
    expect(actorTypes).toEqual(['user', 'device']);
  });

  it('actor_type enum matches actorTypes', () => {
    const t = columnByName(activityLog, 'actor_type');
    expect(t.enumValues).toEqual([...actorTypes]);
  });
});

// ===== PM Agent (ISS-17) =====================================================

describe('db/schema — pm agent enum extensions', () => {
  it('memorySources includes decision and policy', () => {
    expect(memorySources).toContain('decision');
    expect(memorySources).toContain('policy');
  });

  it('notificationTypes includes pm_escalation', () => {
    expect(notificationTypes).toContain('pm_escalation');
  });

  it('jobTypes includes pm', () => {
    expect(jobTypes).toContain('pm');
  });

  it('jobs has partial unique index jobs_pm_per_project_unique_idx', () => {
    const cfg = getTableConfig(jobs);
    const idx = cfg.indexes.find((i) => i.config.name === 'jobs_pm_per_project_unique_idx');
    if (!idx) throw new Error('expected jobs_pm_per_project_unique_idx');
    expect(idx.config.unique).toBe(true);
    expect(idx.config.columns.map((c) => (c as { name?: string }).name)).toEqual(['project_id']);
  });
});

describe('db/schema — issue_dependencies', () => {
  it('exports the kind enum values', () => {
    expect(issueDependencyKinds).toEqual([
      'blocks',
      'relates',
      'duplicates',
      'parent',
      'decomposes',
    ]);
  });

  it('FKs: project + from_issue + to_issue cascade, created_by set null', () => {
    const cfg = getTableConfig(issueDependencies);
    expect(cfg.foreignKeys).toHaveLength(4);
    const byCol = new Map(
      cfg.foreignKeys.map((fk) => [fk.reference().columns[0]?.name ?? '', fk] as const),
    );
    expect(byCol.get('project_id')?.onDelete).toBe('cascade');
    expect(byCol.get('from_issue_id')?.onDelete).toBe('cascade');
    expect(byCol.get('to_issue_id')?.onDelete).toBe('cascade');
    expect(byCol.get('created_by_id')?.onDelete).toBe('set null');
  });

  it('has unique edge index and project-from / project-to indexes', () => {
    const cfg = getTableConfig(issueDependencies);
    const uq = cfg.indexes.find((i) => i.config.name === 'issue_dependencies_unique_edge_idx');
    if (!uq) throw new Error('expected unique edge idx');
    expect(uq.config.unique).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'issue_dependencies_project_from_idx')).toBe(
      true,
    );
    expect(cfg.indexes.some((i) => i.config.name === 'issue_dependencies_project_to_idx')).toBe(
      true,
    );
  });

  it('kind enum matches issueDependencyKinds', () => {
    const k = getTableConfig(issueDependencies).columns.find((c) => c.name === 'kind');
    if (!k) throw new Error('kind column not found');
    expect(k.notNull).toBe(true);
    expect(k.enumValues).toEqual([...issueDependencyKinds]);
  });
});

describe('db/schema — pm_decisions', () => {
  it('project_id cascades on project delete; session_id is bare uuid (no FK)', () => {
    const cfg = getTableConfig(pmDecisions);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.reference().columns[0]?.name).toBe('project_id');
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
  });
});

describe('db/schema — pm_config', () => {
  it('project_id is unique and cascades', () => {
    const cfg = getTableConfig(pmConfig);
    const projectId = cfg.columns.find((c) => c.name === 'project_id');
    if (!projectId) throw new Error('project_id column not found');
    expect(projectId.notNull).toBe(true);
    expect(projectId.isUnique).toBe(true);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('enabled defaults to false', () => {
    const enabled = getTableConfig(pmConfig).columns.find((c) => c.name === 'enabled');
    if (!enabled) throw new Error('enabled column not found');
    expect(enabled.notNull).toBe(true);
    expect(enabled.hasDefault).toBe(true);
    expect(enabled.default).toBe(false);
  });

  it('max_runs_per_hour defaults to 6', () => {
    const c = getTableConfig(pmConfig).columns.find((c) => c.name === 'max_runs_per_hour');
    if (!c) throw new Error('max_runs_per_hour column not found');
    expect(c.notNull).toBe(true);
    expect(c.default).toBe(6);
  });
});

describe('db/schema — pm_policies', () => {
  it('project_id cascades', () => {
    const cfg = getTableConfig(pmPolicies);
    expect(cfg.foreignKeys).toHaveLength(1);
    expect(cfg.foreignKeys[0]?.onDelete).toBe('cascade');
  });

  it('embedding is nullable vector(1536)', () => {
    const c = getTableConfig(pmPolicies).columns.find((c) => c.name === 'embedding');
    if (!c) throw new Error('embedding column not found');
    expect(c.notNull).toBe(false);
    expect(c.getSQLType()).toBe('vector(1536)');
  });

  it('enabled defaults to true and priority defaults to 0', () => {
    const cols = getTableConfig(pmPolicies).columns;
    const enabled = cols.find((c) => c.name === 'enabled');
    const priority = cols.find((c) => c.name === 'priority');
    if (!enabled || !priority) throw new Error('enabled/priority column not found');
    expect(enabled.default).toBe(true);
    expect(priority.default).toBe(0);
  });

  it('has project/enabled/priority and HNSW embedding indexes', () => {
    const cfg = getTableConfig(pmPolicies);
    expect(
      cfg.indexes.some((i) => i.config.name === 'pm_policies_project_enabled_priority_idx'),
    ).toBe(true);
    expect(cfg.indexes.some((i) => i.config.name === 'pm_policies_embedding_hnsw_idx')).toBe(true);
  });
});

describe('tasks table (ISS-146 cascade verification)', () => {
  it('issue_id references issues.id with onDelete cascade so tasks are cleaned up atomically', () => {
    const cfg = getTableConfig(tasks);
    const issueFk = cfg.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => c.name === 'issue_id'),
    );
    if (!issueFk) throw new Error('issue_id FK not found on tasks');
    expect(issueFk.onDelete).toBe('cascade');
  });

  it('project_id references projects.id with onDelete cascade', () => {
    const cfg = getTableConfig(tasks);
    const projectFk = cfg.foreignKeys.find((fk) =>
      fk.reference().columns.some((c) => c.name === 'project_id'),
    );
    if (!projectFk) throw new Error('project_id FK not found on tasks');
    expect(projectFk.onDelete).toBe('cascade');
  });
});

describe('feedbackReports table (ISS-552 C1)', () => {
  it('has the expected columns', () => {
    const names = getTableConfig(feedbackReports)
      .columns.map((c) => c.name)
      .sort();
    expect(names).toEqual(
      [
        'id',
        'project_id',
        'issue_id',
        'run_id',
        'job_id',
        'stage',
        'skill_name',
        'skill_version',
        'kind',
        'severity',
        'target',
        'target_ref',
        'summary',
        'detail',
        'suggestion',
        'candidate_id',
        'signal_key',
        'session_id',
        'reviewed_at',
        'linked_issue_id',
        'created_at',
      ].sort(),
    );
  });

  it('project_id cascades on delete', () => {
    const cfg = getTableConfig(feedbackReports);
    const fk = cfg.foreignKeys.find((k) =>
      k.reference().columns.some((c) => c.name === 'project_id'),
    );
    if (!fk) throw new Error('project_id FK not found');
    expect(fk.onDelete).toBe('cascade');
  });

  it('issue_id, run_id, job_id are nullable (set null on delete)', () => {
    const cfg = getTableConfig(feedbackReports);
    const cols = cfg.columns;
    const issueId = cols.find((c) => c.name === 'issue_id');
    const runId = cols.find((c) => c.name === 'run_id');
    const jobId = cols.find((c) => c.name === 'job_id');
    if (!issueId || !runId || !jobId) throw new Error('nullable FK column not found');
    expect(issueId.notNull).toBe(false);
    expect(runId.notNull).toBe(false);
    expect(jobId.notNull).toBe(false);
  });

  it('severity defaults to "low"', () => {
    const col = getTableConfig(feedbackReports).columns.find((c) => c.name === 'severity');
    if (!col) throw new Error('severity column not found');
    expect(col.default).toBe('low');
  });

  it('has the expected indexes (ISS-557 adds session_id_idx)', () => {
    const names = getTableConfig(feedbackReports).indexes.map((i) => i.config.name);
    expect(names).toContain('feedback_reports_project_id_idx');
    expect(names).toContain('feedback_reports_project_kind_idx');
    expect(names).toContain('feedback_reports_project_target_idx');
    expect(names).toContain('feedback_reports_signal_key_idx');
    expect(names).toContain('feedback_reports_created_at_idx');
    expect(names).toContain('feedback_reports_session_id_idx');
    expect(names).toContain('feedback_reports_linked_issue_id_idx');
  });
});
