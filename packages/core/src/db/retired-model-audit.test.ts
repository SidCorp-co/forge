import { describe, expect, it } from 'vitest';
import {
  type RetiredModelRule,
  RULES,
  scanSource,
  stripComments,
} from '../../../../scripts/check-retired-model.mjs';

function hits(source: string): string[] {
  const code = stripComments(source);
  return RULES.filter((r: RetiredModelRule) => {
    r.re.lastIndex = 0;
    return code.split('\n').some((line) => {
      r.re.lastIndex = 0;
      return r.re.test(line);
    });
  }).map((r) => r.id);
}

describe('the rules name the retired reader', () => {
  it.each([
    [
      "sql`SELECT 1 FROM integration_bindings b WHERE b.environment = 'prod'`",
      'binding-environment-sql',
    ],
    ['sql`... WHERE integration_bindings.environment IS NOT NULL`', 'binding-environment-sql'],
    ['const env = pair.binding.environment;', 'binding-environment-ts'],
    ['if (ctx.environment === "prod") return;', 'binding-environment-ts'],
    ['const b = row.production_branch;', 'production-branch-column'],
    ['const b = project.productionBranch;', 'production-branch-column'],
    ['type Env = "staging" | "prod";', 'inline-environment-union'],
    ['await listActiveBindingsForEnvironment(id);', 'prod-binding-literal'],
    ['const d = await resolveProductionDeclaration(id);', 'prod-binding-literal'],
    ['const c = await resolveReleaseChannel(id);', 'prod-binding-literal'],
    ['const m = projects.releaseModel;', 'release-model-columns'],
    ['const l = projects.liveBranch;', 'release-model-columns'],
    ['const s = projects.releaseStrategy;', 'release-model-columns'],
    ['sql`SELECT release_model FROM projects`', 'release-model-columns'],
    ['sql`... WHERE live_branch IS NOT NULL`', 'release-model-columns'],
    ['sql`... SET release_strategy = NULL`', 'release-model-columns'],
    ['const b = readableLiveBranch(row);', 'release-model-columns'],
    ['const gap = await releaseModelGap(id, updates);', 'release-model-columns'],
    ["if (s === 'tag-mr') return;", 'tag-mr-strategy'],
    ['const branch = row.liveBranch;', 'release-path-keys'],
    ['const live = chainLiveBranch(project.releaseChain);', 'release-path-keys'],
    ['const chain = projects.releaseChain;', 'release-path-keys'],
    ['if (project.autoProdDeploy) deploy();', 'release-path-keys'],
    ['const envs = projects.environments;', 'release-path-keys'],
    ['const s = binding.stages;', 'release-path-keys'],
    ['const c = env.testCredentials;', 'release-path-keys'],
    ['const p = projects.repoPath;', 'device-binding-keys'],
    ['sql`SELECT projects.repo_path FROM projects`', 'device-binding-keys'],
    ['const d = project.defaultDeviceId;', 'device-binding-keys'],
    ['sql`... SET default_device_id = NULL`', 'device-binding-keys'],
    ['const { droppedNames } = resolved;', 'device-binding-keys'],
    ['let dropped_names: Vec<String> = Vec::new();', 'device-binding-keys'],
    ['const repo = resolveRepoPath(null, project.repoPath);', 'device-binding-keys'],
    ['const url = projects.repoUrl;', 'legacy-project-columns'],
    ['.select({ setup: projects.workspaceSetup })', 'legacy-project-columns'],
    ['const k = projects.kind;', 'legacy-project-columns'],
    ['const d = projects.description;', 'legacy-project-columns'],
    ['sql`UPDATE projects SET repo_url = $1`', 'legacy-project-columns'],
    ['sql`SELECT workspace_setup FROM projects`', 'legacy-project-columns'],
    ['sql`UPDATE projects SET environments = $1 WHERE id = $2`', 'legacy-project-columns'],
    ['sql`SELECT projects_release_chain_ok($1)`', 'legacy-project-columns'],
    ['...axes.releaseProjectChecks,', 'legacy-project-columns'],
    ['await syncRepoUrlFromGitHubBinding(args);', 'legacy-project-columns'],
    ['.select({ baseBranch: projects.baseBranch })', 'legacy-project-columns'],
    ['const s = projects.webhookSecret;', 'legacy-project-columns'],
    ['.where(eq(projects.apiKey, key))', 'legacy-project-columns'],
    ["sql`UPDATE projects SET base_branch = 'main' WHERE id = $1`", 'legacy-project-columns'],
    ['sql`SELECT p.base_branch FROM projects p`', 'legacy-project-columns'],
    ['sql`SELECT projects.webhook_secret FROM projects`', 'legacy-project-columns'],
    ['sql`DROP INDEX projects_api_key_uq`', 'legacy-project-columns'],
    ['app.use(requireProjectApiKey);', 'legacy-project-columns'],
    ['const k = generateApiKey();', 'legacy-project-columns'],
    ["routes.post('/:id/api-key/rotate', h);", 'legacy-project-columns'],
    ["const ref = 'secret://project/webhook-secret';", 'generic-inbound-webhook'],
    ['const s = await resolveProjectSecret(id, scope, name);', 'generic-inbound-webhook'],
    ['for (const h of GENERIC_SIGNATURE_HEADERS) read(h);', 'generic-inbound-webhook'],
    [
      "return c.json({ accepted: true, handler: 'generic', actions: 0 });",
      'generic-inbound-webhook',
    ],
  ])('%s → %s', (source, rule) => {
    expect(hits(source)).toContain(rule);
  });
});

describe('the rules leave live code alone', () => {
  it.each([
    "sql`... WHERE b.role = 'deploy' AND 'live' = ANY(b.stages)`",
    'const envs = document.environments;',
    'const path = await readReleasePath(projectId);',
    "if (e.from === 'merge-branch') return;",
    'type Stage = "preview" | "live";',
    'const set = await resolveReleaseChannels(projectId);',
    'const e = deploymentEnvironment;',
    'const x = environmentOf(binding);',
    'const p = runner.repoPath;',
    'sql`SELECT r.repo_path FROM runners r`',
    'const p = session.repoPath;',
    'let repo_path = binding.repo_path.clone();',
    'const r = await testSshConnection(repoUrl, key);',
    'const { setup } = await readDeclaredSource(projectId);',
    'const d = issue.description;',
    'const k = label.kind;',
    'const { defaultBranch } = await readDeclaredSource(projectId);',
    'const base = row.baseBranch;',
    'webhookSecret: body.webhook_secret,',
    'secrets: { apiKey: form.apiKey.trim() },',
    "const ref = 'secret://beta/api-key';",
    'return c.json({ accepted: true, handler: map.provider });',
  ])('%s', (source) => {
    expect(hits(source)).toEqual([]);
  });
});

describe('the comment stripper', () => {
  it('does not let a string containing two slashes hide the rest of its line', () => {
    const line = "const sep = '//'; const b = row.productionBranch;";
    expect(hits(line)).toContain('production-branch-column');
  });

  it('still blanks a real comment, so an obituary is not read as the defect', () => {
    expect(hits('// `production_branch` was renamed by ISS-1046')).toEqual([]);
    expect(hits('/* binding.environment is gone */')).toEqual([]);
  });

  it('preserves the line numbering across a multi-line comment', () => {
    const src = ['const a = 1;', '/*', ' * two', ' * three', ' */', 'const b = 2;'].join('\n');
    expect(stripComments(src).split('\n')).toHaveLength(6);
    expect(stripComments(src).split('\n')[5]).toBe('const b = 2;');
  });

  it('keeps template contents, because one rule reads SQL that only lives in a template', () => {
    expect(stripComments('sql`SELECT b.environment FROM t`')).toContain('b.environment');
  });

  it('re-enters code inside a template substitution, so a nested template hides nothing', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the `${` IS the input under test — source text handed to the lexer, never a template the runtime should interpolate.
    const line = 'const s = `${`//`}`; const b = row.productionBranch;';
    expect(stripComments(line)).toBe(line);
    expect(hits(line)).toContain('production-branch-column');
  });

  it('closes a substitution on its own brace, so a comment inside one is still blanked', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: same reason as above — the `${` is the lexer's input, not an interpolation this file wants performed.
    const line = 'const q = `${ cfg({a: 1}) /* row.productionBranch was renamed */ }`;';
    expect(stripComments(line)).not.toContain('row.productionBranch');
    expect(hits(line)).toEqual([]);
  });
});

const rulesIn = (file: string, source: string) => scanSource(file, source).map((f) => f.rule);

describe('the binding rules, read file by file', () => {
  it.each([
    ['packages/core/src/x.ts', 'await createBinding(db, input);', 'binding-write-doors'],
    ['packages/core/src/x.ts', 'await updateBinding(id, patch);', 'binding-write-doors'],
    ['packages/core/src/x.ts', 'const p: UpdateBindingPatch = {};', 'binding-write-doors'],
    ['packages/core/src/x.ts', 'await bindExisting(projectId, connId);', 'binding-write-doors'],
    ['packages/core/src/x.ts', 'type I = IntegrationBindingCreateInput;', 'binding-write-doors'],
    ['packages/web-v2/src/x.ts', 'useBindExistingConnection(projectId);', 'binding-write-doors'],
    [
      'packages/core/src/x.ts',
      'await db.insert(integrationBindings).values(row);',
      'binding-row-inserts',
    ],
    [
      'packages/core/src/x.ts',
      'sql`INSERT INTO integration_bindings (id) VALUES ($1)`',
      'binding-row-inserts',
    ],
    [
      'packages/core/src/integrations/store.ts',
      'await db.insert(integrationBindings).values(row);',
      'binding-row-inserts',
    ],
    [
      'packages/core/src/x.ts',
      'await db.update(integrationBindings).set({ active: false });',
      'binding-row-updates',
    ],
    [
      'packages/core/src/x.ts',
      'sql`UPDATE integration_bindings SET active = false`',
      'binding-row-updates',
    ],
  ])('%s: %s → %s', (file, source, rule) => {
    expect(rulesIn(file, source)).toContain(rule);
  });

  it.each([
    [
      'packages/core/src/project-config/binding-store.ts',
      'await db.insert(integrationBindings).values(row);',
    ],
    [
      'packages/core/tests/helpers/seed-binding.ts',
      'sql`INSERT INTO integration_bindings (id) VALUES ($1)`',
    ],
    [
      'packages/core/src/project-config/binding-store.ts',
      'await db.update(integrationBindings).set(next);',
    ],
    [
      'packages/core/src/integrations/store.ts',
      'await db.update(integrationBindings).set({ active: false });',
    ],
    [
      'packages/core/tests/integration/x.test.ts',
      'sql`UPDATE integration_bindings SET active = false`',
    ],
    ['packages/core/src/x.ts', 'await writeBinding(projectId, bindingId, doc);'],
  ])('%s: %s stays green', (file, source) => {
    expect(rulesIn(file, source)).toEqual([]);
  });
});

describe('an exact-line allowance', () => {
  it('lets the scrubber keep the one retired key it filters', () => {
    expect(rulesIn('packages/observability/src/index.ts', '\t"testCredentials",')).toEqual([]);
  });

  it('allows that line only, so the same key read elsewhere in the file still goes red', () => {
    expect(
      rulesIn('packages/observability/src/index.ts', 'const c = env.testCredentials;'),
    ).toContain('release-path-keys');
  });

  it('allows that file only, so the same line anywhere else still goes red', () => {
    expect(rulesIn('packages/core/src/x.ts', '\t"testCredentials",')).toContain(
      'release-path-keys',
    );
  });
});
