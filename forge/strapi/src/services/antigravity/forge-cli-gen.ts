/**
 * Forge CLI Generator
 *
 * Generates the forge-api.mjs CLI source with baked-in API URL and key.
 * This is injected into the skills zip so Antigravity agents can use it
 * without setting env vars or copying files.
 *
 * Uses String.raw to avoid template literal escape issues — what you see
 * in the source is (nearly) what gets output as the .mjs file.
 */

export function generateForgeCli(apiUrl: string, apiKey: string): string {
    return buildInlineTemplate(apiUrl, apiKey);
}

/**
 * Inline fallback template when the reference file is not available.
 * This uses String.raw to preserve escape sequences exactly as they should
 * appear in the output JavaScript.
 */
function buildInlineTemplate(apiUrl: string, apiKey: string): string {
    // Note: ${apiUrl} and ${apiKey} are TypeScript interpolations (baked-in config).
    // All other ${...} are escaped with \${ so they appear literally in the output JS.
    const header = `import { readFileSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
/**
 * Forge API CLI — auto-generated with baked-in config.
 * Usage: node forge-api.mjs <tool> <action> [--flag=value] [--nested.key=value] [--data-file=payload.json]
 */

const args = process.argv.slice(2);
const command = args[0] || '';
const baseUrl = process.env.FORGE_API_URL || '${apiUrl}';
const apiKey = process.env.FORGE_API_KEY || '${apiKey}';

if (!baseUrl || !apiKey) {
  console.error('FORGE_API_URL and FORGE_API_KEY env vars required.');
  process.exit(1);
}
`;
    // The body uses String.raw so \\, \`, \$, \n etc. are preserved literally
    const body = String.raw`
// ─── Shared Utilities ──────────────────────────────────────────────────────

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq === -1) { flags[arg.slice(2)] = true; }
      else { flags[arg.slice(2, eq)] = arg.slice(eq + 1); }
    } else { positional.push(arg); }
  }
  return { flags, positional };
}

function resolveValue(value) {
  if (typeof value !== 'string') return value;
  if (value.startsWith('@')) {
    const content = readFileSync(value.slice(1), 'utf-8');
    if (value.endsWith('.json')) { try { return JSON.parse(content); } catch { return content; } }
    return content;
  }
  if ((value.startsWith('[') && value.endsWith(']')) || (value.startsWith('{') && value.endsWith('}'))) {
    try { return JSON.parse(value); } catch { /* keep as string */ }
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return value;
}

async function api(method, path, body) {
  const opts = { method, headers: { 'x-forge-api-key': apiKey, 'Accept': 'application/json, text/event-stream' } };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(` + '`${baseUrl}${path}`' + String.raw`, opts);
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) {
    console.error(` + '`HTTP ${res.status} ${res.statusText}`' + String.raw`);
    console.error(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2));
    process.exit(1);
  }
  return parsed;
}

function output(data) {
  if (typeof data === 'string') {
    try { console.log(JSON.stringify(JSON.parse(data), null, 2)); }
    catch { console.log(data); }
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

// ─── Forge Tool Caller ────────────────────────────────────────────────────

const TOOL_MAP = {
  'issues': 'forge_issues', 'comments': 'forge_comments', 'memory': 'forge_memory',
  'skills': 'forge_skills', 'language': 'forge_language', 'config': 'forge_config',
  'coolify': 'forge_coolify_deploy', 'sentry': 'forge_sentry', 'cloudflare': 'forge_cloudflare',
  'projects': 'forge_projects', 'health': 'forge_health', 'pipeline': 'forge_pipeline',
  'activity': 'forge_activity', 'schedule': 'forge_schedule',
  'agent-sessions': 'forge_agent_sessions', 'claude': 'forge_claude',
  'integration-guide': 'forge_integration_guide', 'code-run': 'code_run',
};

async function mcpRequest(method, params) {
  const mcpBase = baseUrl.replace(/\/api$/, '');
  const body = { jsonrpc: '2.0', id: 1, method, params };
  const res = await fetch(` + '`${mcpBase}/mcp`' + String.raw`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json, text/event-stream', 'x-forge-api-key': apiKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) { console.error(` + '`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`' + String.raw`); process.exit(1); }
  const contentType = res.headers.get('content-type') || '';
  const text = await res.text();
  if (contentType.includes('text/event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      try {
        const data = JSON.parse(line.slice(6));
        if (data.result) return data.result;
        if (data.error) { console.error(` + '`MCP error: ${data.error.message || JSON.stringify(data.error)}`' + String.raw`); process.exit(1); }
      } catch {}
    }
    console.error('No response in SSE stream'); process.exit(1);
  }
  let parsed; try { parsed = JSON.parse(text); } catch { console.error(` + '`Unexpected response: ${text.slice(0, 500)}`' + String.raw`); process.exit(1); }
  if (parsed?.result) return parsed.result;
  if (parsed?.error) { console.error(` + '`MCP error: ${parsed.error.message || JSON.stringify(parsed.error)}`' + String.raw`); process.exit(1); }
  console.error(` + '`Unexpected response: ${text.slice(0, 500)}`' + String.raw`); process.exit(1);
}

async function forgeCall(toolName, toolArgs) {
  const result = await mcpRequest('tools/call', { name: toolName, arguments: toolArgs });
  return result.content?.[0]?.text || JSON.stringify(result);
}

function sampleValue(schema, name) {
  if (!schema) return ` + '`<${name}>`' + String.raw`;
  if (schema.enum && schema.enum.length) return String(schema.enum[0]);
  if (schema.type === 'string') return ` + '`"<${name}>"`' + String.raw`;
  if (schema.type === 'number' || schema.type === 'integer') return '0';
  if (schema.type === 'boolean') return 'true';
  if (schema.type === 'array') return '[]';
  if (schema.type === 'object') return '{}';
  return ` + '`<${name}>`' + String.raw`;
}

function flagsForAction(toolSchema, action) {
  // Walk schema.properties and emit a flag table + concrete example for one action.
  const props = toolSchema.properties || {};
  const required = new Set(toolSchema.required || []);
  const rows = [];
  const exampleFlags = [];
  for (const [key, prop] of Object.entries(props)) {
    if (key === 'action') continue;
    if (prop.type === 'object' && prop.properties) {
      for (const [sub, subProp] of Object.entries(prop.properties)) {
        const flagName = ` + '`--${key}.${sub}`' + String.raw`;
        const type = subProp.type || (subProp.enum ? 'enum' : 'any');
        const enumHint = subProp.enum ? ` + '` (${subProp.enum.slice(0, 5).join("|")}${subProp.enum.length > 5 ? "..." : ""})`' + String.raw` : '';
        const desc = (subProp.description || '').split('\n')[0].slice(0, 80);
        rows.push({ flag: flagName, type: type + enumHint, req: '', desc });
      }
      continue;
    }
    const flagName = ` + '`--${key}`' + String.raw`;
    const type = prop.type || (prop.enum ? 'enum' : 'any');
    const enumHint = prop.enum ? ` + '` (${prop.enum.slice(0, 5).join("|")}${prop.enum.length > 5 ? "..." : ""})`' + String.raw` : '';
    const desc = (prop.description || '').split('\n')[0].slice(0, 80);
    const req = required.has(key) ? 'yes' : '';
    rows.push({ flag: flagName, type: type + enumHint, req, desc });
    if (required.has(key) && key !== 'action') {
      exampleFlags.push(` + '`${flagName}=${sampleValue(prop, key)}`' + String.raw`);
    }
  }
  return { rows, exampleFlags };
}

async function showHelp(command) {
  // General help: no command or "help"
  if (!command || command === 'help') {
    console.log('Forge API CLI — self-documenting wrapper for the Forge MCP tools.');
    console.log('');
    console.log('USAGE');
    console.log('  node forge-api.mjs <tool> <action> [--data.<field>=<value>] [--filters.<field>=<value>]');
    console.log("  node forge-api.mjs <tool> --help                   Show a tool's actions, schema, and examples");
    console.log('  node forge-api.mjs --help                          Show this message');
    console.log('');
    console.log('HOW TO LEARN A TOOL');
    console.log('  1. Pick the tool by name from the list below.');
    console.log('  2. Run "node forge-api.mjs <tool> --help" — it prints the live JSON Schema,');
    console.log('     a per-action example, and a flag table. DO NOT guess flag names.');
    console.log('  3. Call the tool with --data.<field>=<value> for payload fields.');
    console.log('');
    console.log('TOOLS');
    console.log('  ' + Object.keys(TOOL_MAP).join(', '));
    console.log('');
    console.log('PAYLOAD CONVENTION');
    console.log('  - action is positional:           node forge-api.mjs comments create ...');
    console.log('  - payload fields go under --data: --data.body="..."  --data.issue=<id>');
    console.log('  - filters go under --filters:     --filters.status=open');
    console.log('  - nested dot-notation builds objects: --data.user.name=Alice → {data:{user:{name:"Alice"}}}');
    console.log('  - @file reads value from a file:  --data.body=@report.md');
    console.log('  - inline JSON for arrays/objects: --data.attachments=[42,43]');
    console.log('  - true/false/null/numbers auto-parsed');
    console.log('  - --data-file=payload.json loads the full args object from a file');
    console.log('');
    console.log('EXAMPLES');
    console.log('  node forge-api.mjs issues list --filters.status=open');
    console.log('  node forge-api.mjs issues get <documentId>');
    console.log('  node forge-api.mjs comments create --data.body=@report.md --data.issue=<id> --data.author=Name');
    console.log('  node forge-api.mjs memory search --data.query="deployment" --data.strategy=hybrid');
    console.log('');
    console.log('LEGACY COMMANDS (still supported)');
    console.log('  get-issue, update-issue, search-issues, list-comments, create-comment,');
    console.log('  upload, search-memory, add-memory');
    console.log('');
    console.log('When unsure: run "<tool> --help" first. Never guess.');
    return;
  }
  // Tool-specific help
  const toolName = TOOL_MAP[command];
  if (!toolName) {
    console.error(` + '`Unknown tool: ${command}`' + String.raw`);
    console.error('Available tools: ' + Object.keys(TOOL_MAP).join(', '));
    console.error('Run "node forge-api.mjs --help" for general usage.');
    process.exit(1);
  }
  const result = await mcpRequest('tools/list', {});
  const tool = (result.tools || []).find(t => t.name === toolName);
  if (!tool) { console.error(` + '`Tool ${toolName} not found on server`' + String.raw`); process.exit(1); }

  console.log(` + '`TOOL: ${command}  (MCP: ${tool.name})`' + String.raw`);
  console.log('');
  if (tool.description) {
    console.log('DESCRIPTION');
    console.log('  ' + tool.description.split('\n').join('\n  '));
    console.log('');
  }

  const schema = tool.inputSchema || {};
  const actionProp = schema.properties?.action;
  const actions = actionProp?.enum || [];

  if (actions.length) {
    console.log('ACTIONS');
    for (const a of actions) { console.log('  ' + a); }
    console.log('');
  }

  const { rows, exampleFlags } = flagsForAction(schema, actions[0]);
  if (rows.length) {
    console.log('FLAGS');
    const maxFlag = Math.max(...rows.map(r => r.flag.length));
    const maxType = Math.max(...rows.map(r => r.type.length));
    for (const r of rows) {
      const flag = r.flag.padEnd(maxFlag);
      const type = r.type.padEnd(maxType);
      const req = r.req ? '*' : ' ';
      console.log(` + '`  ${req} ${flag}  ${type}  ${r.desc}`' + String.raw`);
    }
    console.log('  (* = required)');
    console.log('');
  }

  console.log('EXAMPLE');
  const sampleAction = actions[0] || '<action>';
  const exampleLine = [` + '`node forge-api.mjs ${command} ${sampleAction}`' + String.raw`, ...exampleFlags].join(' \\\n    ');
  console.log('  ' + exampleLine);
  console.log('');

  console.log('RAW INPUT SCHEMA (authoritative — use this if the summary above is unclear)');
  const schemaStr = JSON.stringify(schema, null, 2);
  for (const line of schemaStr.split('\n')) { console.log('  ' + line); }
  console.log('');
  console.log('CALLING CONVENTION');
  console.log('  - action is positional: node forge-api.mjs ' + command + ' <action>');
  console.log('  - payload fields → --data.<field>=<value>');
  console.log('  - nested objects → dot-notation (--data.user.name=Alice)');
  console.log('  - file value → --data.body=@report.md');
  console.log('  - inline JSON → --data.attachments=[42,43]');
}

function buildToolArgs(action, positionalArgs, flags) {
  let toolArgs = {};
  if (flags['data-file']) { toolArgs = JSON.parse(readFileSync(flags['data-file'], 'utf-8')); }
  if (action) toolArgs.action = action;
  if (positionalArgs[0]) toolArgs.documentId = positionalArgs[0];
  for (const [key, val] of Object.entries(flags)) {
    if (key === 'data-file') continue;
    const parts = key.split('.');
    let target = toolArgs;
    for (let i = 0; i < parts.length - 1; i++) {
      if (!target[parts[i]] || typeof target[parts[i]] !== 'object') target[parts[i]] = {};
      target = target[parts[i]];
    }
    target[parts[parts.length - 1]] = resolveValue(val);
  }
  // Hoist data.* fields to top level so --data.query and --query both work.
  // Tool handlers check top-level (input.query, input.documentId) while
  // agents often follow the --data.* convention from the help text.
  if (toolArgs.data && typeof toolArgs.data === 'object') {
    for (const [k, v] of Object.entries(toolArgs.data)) {
      if (!(k in toolArgs)) toolArgs[k] = v;
    }
  }
  return toolArgs;
}

// ─── Legacy REST Commands ──────────────────────────────────────────────────

function pickFields(obj, fieldsStr) {
  if (!fieldsStr) return obj;
  const fields = fieldsStr.split(',').map(f => f.trim());
  const result = {};
  for (const f of fields) { result[f] = obj[f] !== undefined ? obj[f] : null; }
  return result;
}

function slimIssue(issue) {
  const { documentId, title, status, category, priority, complexity,
    description, acceptanceCriteria, aiAcceptanceCriteria,
    plan, changeHistory } = issue;
  return { documentId, title, status, category, priority, complexity,
    description, acceptanceCriteria, aiAcceptanceCriteria,
    plan, changeHistory };
}

async function getIssue(docId, flags) {
  const result = await api('GET', ` + '`/issues?filters[documentId][$eq]=${encodeURIComponent(docId)}&populate=*`' + String.raw`);
  const issue = result?.data?.[0];
  if (!issue) { console.error(` + '`Issue ${docId} not found`' + String.raw`); process.exit(1); }
  if (flags.fields) { output(pickFields(issue, flags.fields)); }
  else if (flags.raw) { output(issue); }
  else { output(slimIssue(issue)); }
}

async function updateIssue(docId, flags) {
  let data = {};
  if (flags['data-file']) { data = JSON.parse(readFileSync(flags['data-file'], 'utf-8')); }
  else {
    for (const f of ['status','category','priority','complexity','plan','title','description','acceptanceCriteria','suggestedSolution','relations','sessionContext']) {
      if (flags[f] !== undefined) data[f] = resolveValue(flags[f]);
    }
  }
  if (!Object.keys(data).length) { console.error('No fields to update.'); process.exit(1); }
  output(await api('PUT', ` + '`/issues/${docId}`' + String.raw`, { data }));
}

async function searchIssues(terms, flags) {
  const exclude = flags.exclude || '', limit = flags.limit || 10;
  const keywords = terms.split(/\s+/).filter(Boolean);
  const filters = [];
  for (const kw of keywords) {
    filters.push(` + '`filters[$or][${filters.length}][title][$containsi]=${encodeURIComponent(kw)}`' + String.raw`);
    filters.push(` + '`filters[$or][${filters.length}][description][$containsi]=${encodeURIComponent(kw)}`' + String.raw`);
  }
  let qs = filters.join('&');
  if (exclude) qs += ` + '`&filters[documentId][$ne]=${encodeURIComponent(exclude)}`' + String.raw`;
  qs += ` + '`&pagination[pageSize]=${limit}`' + String.raw`;
  output((await api('GET', ` + '`/issues?${qs}`' + String.raw`))?.data || []);
}

async function listComments(issueDocId, flags) {
  const limit = flags.limit || 10;
  const data = (await api('GET', ` + '`/comments?filters[issue][documentId][$eq]=${encodeURIComponent(issueDocId)}&sort=createdAt:desc&pagination[pageSize]=${limit}`' + String.raw`))?.data || [];
  if (flags.raw) { output(data); return; }
  output(data.map(c => ({ author: c.author, body: c.body, createdAt: c.createdAt })));
}

async function createComment(issueDocId, flags) {
  let body, author, attachments;
  if (flags['data-file']) {
    const content = JSON.parse(readFileSync(flags['data-file'], 'utf-8'));
    body = content.body; author = content.author || flags.author; attachments = content.attachments;
  } else {
    if (!flags.body) { console.error('--body or --data-file required'); process.exit(1); }
    body = resolveValue(flags.body); author = flags.author;
  }
  if (flags.attachments && !attachments) { attachments = String(flags.attachments).split(',').map(Number).filter(n => !isNaN(n)); }
  if (!author) { console.error('--author is required'); process.exit(1); }
  const data = { body, issue: issueDocId, author };
  if (attachments?.length) data.attachments = attachments;
  output(await api('POST', '/comments', { data }));
}

async function searchMemory(query, flags) {
  const limit = flags.limit || 5;
  const body = { query, limit };
  if (flags.strategy) body.strategy = flags.strategy;
  if (flags.skill) body.skill = flags.skill;
  const result = await api('POST', '/memories/search', body);
  output(result?.data || []);
}

async function addMemory(content, flags) {
  const body = { content };
  if (flags.role) body.role = flags.role;
  if (flags.category) body.category = flags.category;
  if (flags.visibility) body.visibility = flags.visibility;
  if (flags.scope) body.scope = flags.scope;
  const result = await api('POST', '/memories/add', body);
  output(result?.data || result);
}

async function uploadFile(filePath) {
  if (!existsSync(filePath)) { console.error(` + '`File not found: ${filePath}`' + String.raw`); process.exit(1); }
  const fileBuffer = readFileSync(filePath);
  const fileName = basename(filePath);
  const ext = extname(filePath).toLowerCase();
  const mimeTypes = { '.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp','.svg':'image/svg+xml','.pdf':'application/pdf','.json':'application/json','.txt':'text/plain','.md':'text/markdown' };
  const form = new FormData();
  form.append('file', new Blob([fileBuffer], { type: mimeTypes[ext] || 'application/octet-stream' }), fileName);
  const res = await fetch(` + '`${baseUrl}/comments/upload`' + String.raw`, { method: 'POST', headers: { 'x-forge-api-key': apiKey }, body: form });
  const text = await res.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = text; }
  if (!res.ok) { console.error(` + '`HTTP ${res.status} ${res.statusText}`' + String.raw`); console.error(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)); process.exit(1); }
  output(parsed);
}

// ─── Command Dispatch ──────────────────────────────────────────────────────

const { flags, positional } = parseFlags(args.slice(1));

// Help dispatch: "--help" / "-h" / bare "help" / no command → show help (general or tool-specific)
if (command === 'help' || command === '--help' || command === '-h' || !command) {
  await showHelp(positional[0]);
  process.exit(0);
}
if (flags.help || flags.h) {
  await showHelp(command);
  process.exit(0);
}

switch (command) {
  case 'get-issue':
    if (!positional[0]) { console.error('Usage: get-issue <documentId> [--fields=f1,f2]'); process.exit(1); }
    await getIssue(positional[0], flags); break;
  case 'update-issue':
    if (!positional[0]) { console.error('Usage: update-issue <documentId> --field=value'); process.exit(1); }
    await updateIssue(positional[0], flags); break;
  case 'search-issues':
    if (!positional[0]) { console.error('Usage: search-issues "keywords" --exclude=<id>'); process.exit(1); }
    await searchIssues(positional[0], flags); break;
  case 'list-comments':
    if (!positional[0]) { console.error('Usage: list-comments <issueDocId> --limit=5'); process.exit(1); }
    await listComments(positional[0], flags); break;
  case 'create-comment':
    if (!positional[0]) { console.error('Usage: create-comment <issueDocId> --body=@file.md --author=Name'); process.exit(1); }
    await createComment(positional[0], flags); break;
  case 'upload':
    if (!positional[0]) { console.error('Usage: upload <filepath>'); process.exit(1); }
    await uploadFile(positional[0]); break;
  case 'search-memory':
    if (!positional[0]) { console.error('Usage: search-memory "query" --strategy=hybrid --limit=5'); process.exit(1); }
    await searchMemory(positional[0], flags); break;
  case 'add-memory':
    if (!positional[0]) { console.error('Usage: add-memory "content" --role=dev --category=correction'); process.exit(1); }
    await addMemory(positional[0], flags); break;

  default: {
    const toolName = TOOL_MAP[command];
    if (toolName) {
      if (!positional[0]) {
        await showHelp(command);
        process.exit(0);
      }
      const action = positional[0];
      const toolArgs = buildToolArgs(action, positional.slice(1), flags);
      const result = await forgeCall(toolName, toolArgs);
      output(result);
    } else {
      console.error(` + '`Unknown command: ${command}`' + String.raw`);
      console.error('Run "node forge-api.mjs --help" for usage, or "node forge-api.mjs <tool> --help" for a tool schema.');
      process.exit(1);
    }
  }
}
`;
    return header + body;
}
