#!/usr/bin/env node

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const JSON_OUT = process.argv.includes('--json');

const SKIP =
  /(^|[/\\])(node_modules|\.next|dist|target|coverage|\.git|\.turbo|\.worktrees)([/\\]|$)/;
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.rs']);
const TS_EXT = new Set(['.ts', '.tsx', '.mjs', '.js']);

const ALLOW = [
  /^packages\/core\/src\/projects\/agent-config-schema\.ts$/,
  // This checker names what it hunts.
  /^scripts\/check-retired-model\.mjs$/,
  // ISS-16 — the read-only export reads the dropped columns of a database that still has them.
  /^scripts\/export-legacy-project-config\.mjs$/,
  // ISS-12 — spells a deleted key to prove the door refuses it by name.
  /^packages\/core\/src\/projects\/retired-project-keys\.ts$/,
];

// One exact line, not a file: the rest of the file stays under every rule.
export const ALLOW_LINES = [
  {
    file: 'packages/observability/src/index.ts',
    rule: 'release-path-keys',
    text: '"testCredentials",',
    why: 'the scrubber filters a retired secret-bearing key for ever: old clients, logs and replays still send it, and dropping the key sends their credentials out unscrubbed.',
  },
];

export function lineAllowed(file, ruleId, line) {
  const text = line.trim();
  return ALLOW_LINES.some((a) => a.file === file && a.rule === ruleId && a.text === text);
}

const words = (...names) => `\\b(?:${names.join('|')})\\b`;
const projectsColumn = (...names) => `\\bprojects\\.(?:${names.join('|')})\\b`;
const anyOf = (...alternatives) => new RegExp(alternatives.join('|'), 'g');

const RELEASE_AXES = ['liveBranch', 'releaseModel', 'releaseStrategy'];

const BINDING_STORE = [
  /^packages\/core\/src\/project-config\/binding-store\.ts$/,
  /^packages\/core\/tests\//,
];

export const RULES = [
  {
    id: 'binding-environment-sql',
    // `b.environment`, `integration_bindings.environment`, `"environment" text` in a sql template
    re: /\b(?:integration_bindings|\bb)\.environment\b/g,
    why: "raw SQL still reads `integration_bindings.environment`, a column ISS-1046 dropped. Nothing type-checks a `sql` template, so this matches no row rather than failing. The environment a deploy binding serves is the project document's `environments.<name>.deployment.binding` (ISS-8): read it with `project-config/release-path.ts:readDeployMap`.",
  },
  {
    id: 'binding-environment-ts',
    // `binding.environment`, `pair.binding.environment`, `row.environment` beside a provider read
    re: /\bbinding\.environment\b|\bctx\.environment\b/g,
    why: 'a binding still exposes `environment`, which ISS-1046 retired. Read the one the value actually meant: `role` for what the binding is FOR, and the project document (`project-config/release-path.ts:readDeployMap`) for which environment a deploy binding serves.',
  },
  {
    id: 'production-branch-column',
    re: anyOf(words('production_branch', 'productionBranch')),
    why: "`production_branch` / `productionBranch` names a column that does not exist: the branch production deploys from is the project document's production environment `deploysFrom` (ISS-12).",
  },
  {
    id: 'inline-environment-union',
    re: /["'](?:staging|prod)["']\s*\|\s*["'](?:staging|prod)["']/g,
    why: 'an inline `"staging" | "prod"` union is a private copy of an enum that no longer exists. web-v2 held seven of these importing nothing from contracts, so the contracts change alone broke none of them. Use `BindingRole`, and the project document\'s environment names.',
  },
  {
    id: 'release-model-columns',
    // `projects.releaseModel`, `release_model` / `live_branch` / `release_strategy` in a sql
    // template, and the helpers the columns were gated by.
    re: anyOf(
      projectsColumn(...RELEASE_AXES),
      words(
        'release_model',
        'live_branch',
        'release_strategy',
        'readableLiveBranch',
        'releaseModelGap',
        'LIVE_BRANCH_REQUIRED',
      ),
    ),
    why: '`release_model`, `live_branch` and `release_strategy` were retired by ISS-1311, and the chain that replaced them by ISS-12 (ADR 0004). Nothing type-checks a `sql` template, so a read of one of these matches no row rather than failing. Read the project document: `project-config/release-path.ts:readReleasePath`.',
  },
  {
    id: 'release-path-keys',
    // ISS-12 / design D8 — the keys the project document replaced, read or written anywhere.
    re: anyOf(
      words(
        'releaseChain',
        'release_chain',
        ...RELEASE_AXES,
        'autoProdDeploy',
        'testCredentials',
        'chainLiveBranch',
        'retiredReleaseAxes',
        'DeployStage',
        'deployStages',
      ),
      projectsColumn('environments'),
      /\bbinding\.stages\b/.source,
    ),
    why: "ISS-12 deleted this key with every reader and writer, and ISS-16 dropped its columns: where a release goes, what an environment is and how it is tested are the project document (`PUT /api/projects/:id/config`, ADR 0004), and which environment a deploy binding serves is the document's `deployment.binding`. Read `project-config/release-path.ts`.",
  },
  {
    id: 'device-binding-keys',
    // ISS-14 / design D8 — the project checkout and default device the device binding replaced,
    // the project-declared MCP servers the granted bindings replaced, and their helpers.
    re: anyOf(
      projectsColumn('repoPath', 'repo_path'),
      words(
        'defaultDeviceId',
        'default_device_id',
        'droppedNames',
        'dropped_names',
        'projectDefaultRepoPath',
        'resolveRepoPath',
        'loadRepoPath',
        'McpServerSource',
        'fallback_cwd',
      ),
    ),
    why: "ISS-14 deleted this with every reader and writer: a checkout is a path on one box, named by that device binding (`runners.repo_path`, `forge-runner bind <slug> --path <dir>`), and no box is a project's default. A job reads its cwd from `jobs/prepare-claimed-job.ts:resolveRunnerForDevice`, a turn from `lib/device-pool.ts:resolveSessionRepoPathForDevice`, and a binding that names none is refused CHECKOUT_UNBOUND. An agent's MCP servers are its project's granted integration bindings alone (`jobs/resolve-job-mcp-servers.ts`), so nothing is declared that could be dropped.",
    exts: [...EXT],
  },
  {
    id: 'binding-write-doors',
    // ISS-15 — the doors that wrote a binding beside the binding-v1 document, and their callers.
    re: anyOf(
      words(
        'createBinding',
        'updateBinding',
        'UpdateBindingPatch',
        'bindExisting',
        'IntegrationBindingCreateInput',
      ),
      // No leading boundary: the retired hook was `useBindExistingConnection`.
      /\w*BindExistingConnection\w*/.source,
    ),
    why: 'ISS-15 deleted every binding write but one: a binding is a binding-v1 document, written by `PUT /api/projects/:projectId/bindings/:bindingId` through `project-config/bindings.ts:writeBinding`, whose `bind-effects.ts` mints the inbound secret, authorises `agentAccess` and runs `onBindingCreated`. A connection is created with `POST /api/integration-connections` and named in the document. A suite seeds a row with `tests/helpers/seed-binding.ts:seedBinding`.',
  },
  {
    id: 'binding-row-inserts',
    // ISS-15 — a binding row is inserted by the document's store alone; a suite may seed one.
    re: /\.insert\(integrationBindings\)|\bINSERT INTO integration_bindings\b/g,
    allow: BINDING_STORE,
    why: 'ISS-15: a binding row is inserted only by `project-config/binding-store.ts:casBinding`, under the binding-v1 document that `PUT /api/projects/:projectId/bindings/:bindingId` writes. Write the document; do not add a second door onto `integration_bindings`.',
  },
  {
    id: 'binding-row-updates',
    // ISS-15 — only the inbound-secret rotation stays a row update; a switch-off is a binding document.
    re: /\.update\(integrationBindings\)|\bUPDATE integration_bindings\b/g,
    allow: BINDING_STORE,
    why: 'ISS-15: what a binding declares, `active` and `instructions` among it, is changed only by a binding-v1 document (`project-config/binding-store.ts:casBinding`). Switching a binding off is DELETE /api/projects/:projectId/bindings/:bindingId, which `project-config/bindings.ts:removeBinding` writes through the same document. The row updates left are `project-config/binding-store.ts:setBindingInboundSecret`, which rotation writes, and `project-config/binding-store.ts:encryptPlaintextBindingSecrets`, which encrypts a pre-0404 plaintext inbound secret at boot. Write the document instead of updating the row.',
  },
  {
    id: 'legacy-project-columns',
    // ISS-16 / design D8 — the `projects` columns the project document replaced, and the helpers
    // that wrote or checked them.
    re: anyOf(
      projectsColumn(
        'description',
        'kind',
        'repoUrl',
        'workspaceSetup',
        'baseBranch',
        'webhookSecret',
        'apiKey',
        'webhook_secret',
        'api_key',
      ),
      /\bprojects\s+SET\s+(?:description|kind|environments|base_branch|webhook_secret|api_key)\b/
        .source,
      words(
        'repo_url',
        'workspace_setup',
        'base_branch',
        'projects_api_key_uq',
        'requireProjectApiKey',
        'generateApiKey',
        'projects_release_chain_(?:ok|chk)',
        'releaseProjectChecks',
        'releaseCrossings',
        'syncRepoUrlFromGitHubBinding',
        'RepoUrlOutcome',
      ),
      /\/api-key\/rotate\b/.source,
    ),
    why: "ISS-16 dropped this `projects` column (migrations `the_legacy_project_columns_are_dropped` and `the_branch_and_the_project_secrets_leave_the_row`) with every reader and writer, and moved nothing into another column: a project's repository is its document's `source.git.repository`, the branch work is cut from is `source.git.defaultBranch` and its setup procedure is `workspace.setup` (`project-config/source.ts:readDeclaredSource`), whether its work lands in git is `source.type`, and a project carries no description. A project holds no webhook secret (see `generic-inbound-webhook`) and no API key. `PATCH /api/projects/:id`, `POST /api/projects` and `forge_projects` refuse `repoUrl`, `workspaceSetup`, `baseBranch`, `webhookSecret` and `apiKey` by name. To read what an old database still holds, run `scripts/export-legacy-project-config.mjs` against it.",
  },
  {
    id: 'generic-inbound-webhook',
    re: anyOf(
      /secret:\/\/project\/webhook-secret/.source,
      words('GENERIC_SIGNATURE_HEADERS', 'resolveProjectSecret'),
      /handler:\s*['"`]generic['"`]|webhook: generic receive/.source,
    ),
    why: "ISS-16 removed the generic inbound webhook: `POST /api/webhooks/in/:slug` with no provider header verified a project secret and then reached nothing, and now answers 410 `WEBHOOK_ROUTE_REMOVED` (`integration-door/webhook-inbound-routes.ts:routeRemoved`). A provider's webhook is verified with its integration binding's secret; there is no project webhook secret to read.",
  },
  {
    id: 'tag-mr-strategy',
    re: /(['"`])tag-mr\1/g,
    why: "`tag-mr` was removed by ISS-1311 (ADR 0003): it had no behaviour, no document and no project that declared it, and the migration aborts on a row carrying it rather than rewriting it. A release crosses an edge by `merge-branch` or `cherry-pick`, declared as that entry's `from`.",
  },
  {
    id: 'prod-binding-literal',
    re: /listActiveBindingsForEnvironment|resolveProductionDeclaration\b|\bresolveReleaseChannel\b(?!s)/g,
    why: 'this function was replaced by ISS-1046 and then by the project document (ISS-12): `resolveReleaseDeclaration` and `resolveReleaseChannels`, which read the production environment of `project-config/release-path.ts`.',
  },
];

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (SKIP.test(relative(ROOT, full))) continue;
    if (e.isDirectory()) walk(full, out);
    else if (EXT.has(extname(e.name))) out.push(full);
  }
  return out;
}

export function stripComments(src) {
  let out = '';
  let i = 0;
  // 'code' | 'line' | 'block' | "'" | '"' | '`'
  let state = 'code';
  // One frame per OPEN `${`, holding how many plain `{` are nested inside it. A template
  // substitution is code again, so `` `${'//'}` `` opens a string the scan must not read as a
  // comment, and the `}` that closes it must return to the template rather than to top-level code.
  const subs = [];
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (subs.length > 0 && c === '{') {
        subs[subs.length - 1].depth += 1;
        out += c;
        i += 1;
        continue;
      }
      if (subs.length > 0 && c === '}') {
        const frame = subs[subs.length - 1];
        if (frame.depth === 0) {
          subs.pop();
          state = '`';
        } else {
          frame.depth -= 1;
        }
        out += c;
        i += 1;
        continue;
      }
      if (c === '/' && next === '/') {
        state = 'line';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') state = c;
      out += c;
      i += 1;
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        out += c;
      } else {
        out += ' ';
      }
      i += 1;
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 2;
        continue;
      }
      // newlines survive so the line numbering below a block comment stays true
      out += c === '\n' ? c : ' ';
      i += 1;
      continue;
    }
    // inside a string or template: copy verbatim, honouring the escape
    if (state === '`' && c === '$' && next === '{') {
      subs.push({ depth: 0 });
      state = 'code';
      out += '${';
      i += 2;
      continue;
    }
    if (c === '\\') {
      out += c + (next ?? '');
      i += 2;
      continue;
    }
    if (c === state) state = 'code';
    out += c;
    i += 1;
  }
  return out;
}

/** Every finding in `src`, read as the repository file `rel`, with every allowance applied. */
export function scanSource(rel, src) {
  if (ALLOW.some((re) => re.test(rel))) return [];
  const ext = extname(rel);
  const rust = ext === '.rs';
  const lines = rust
    ? src.split('\n').map((line) => (/^\s*\/\//.test(line) ? '' : line))
    : stripComments(src).split('\n');
  const findings = [];
  for (const rule of RULES) {
    if (!(rule.exts ? rule.exts.includes(ext) : TS_EXT.has(ext))) continue;
    if (rule.allow?.some((re) => re.test(rel))) continue;
    lines.forEach((line, i) => {
      rule.re.lastIndex = 0;
      if (!rule.re.test(line)) return;
      if (lineAllowed(rel, rule.id, line)) return;
      findings.push({
        file: rel,
        line: i + 1,
        rule: rule.id,
        text: line.trim().slice(0, 160),
        why: rule.why,
      });
    });
  }
  return findings;
}

function main() {
  let files;
  try {
    files = walk(join(ROOT, 'packages'), []).concat(walk(join(ROOT, 'scripts'), []));
  } catch (err) {
    console.error(`check-retired-model: could not walk the tree: ${err.message}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error('check-retired-model: scope matched no files — the walk found nothing to scan');
    process.exit(2);
  }

  const findings = [];
  for (const file of files) {
    const rel = relative(ROOT, file);
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    findings.push(...scanSource(rel, src));
  }

  if (JSON_OUT) {
    console.log(JSON.stringify({ scanned: files.length, findings }, null, 2));
  } else {
    console.log(`check-retired-model: ${files.length} files scanned`);
    for (const f of findings) {
      console.error(`  ${f.file}:${f.line}  [${f.rule}]\n    ${f.text}\n    ${f.why}`);
    }
    if (findings.length === 0) console.log('  no retired release-model reader survives');
    else console.error(`\ncheck-retired-model: ${findings.length} retired reader(s)`);
  }
  process.exit(findings.length === 0 ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
