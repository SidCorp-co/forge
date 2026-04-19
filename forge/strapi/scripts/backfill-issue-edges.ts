/**
 * Backfill knowledge graph edges from existing issues via prod Strapi API.
 *
 * Usage:
 *   npx tsx scripts/backfill-issue-edges.ts [--dry-run] [--limit N]
 *
 * Env:
 *   STRAPI_URL       — e.g. http://localhost:1337/api (default)
 *   STRAPI_USER      — login identifier
 *   STRAPI_PASSWORD   — login password
 *   LITELLM_API_URL  — LLM proxy for edge extraction
 *   LITELLM_API_KEY  — optional LLM auth
 */
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const STRAPI_URL = process.env.STRAPI_URL || 'http://localhost:1337/api';
const STRAPI_USER = process.env.STRAPI_USER || '';
const STRAPI_PASSWORD = process.env.STRAPI_PASSWORD || '';

const ISSUE_EDGE_PROMPT = `Extract entity relationships from this issue. Output structural connections only.

## Rules
- Extract subject→predicate→object triples that reveal project structure
- Preserve original language. Vietnamese stays Vietnamese.
- Max 5 edges. If nothing structural, output {"edges":[]}
- Focus on: page/feature ownership, dependencies, module relationships, rules

## Predicates
role_in, owns, depends_on, has_rule, has_convention, related_to, part_of, uses, affects, requires

## Good edges
- "/attendance" —has_rule→ "break hour deduction": issue about break hours on attendance page
- "miễn chấm công" —part_of→ "/employee": attendance exempt feature on employee page
- "payroll integration" —depends_on→ "attendance data": payroll needs attendance
- "HR admin" —owns→ "/attendance export": HR admin manages attendance export

## Bad edges (skip these)
- Generic: "user" —uses→ "system"
- Obvious: "issue" —related_to→ "project"
- Too specific: "ISS-175" —has_status→ "open"

## Input
Title: {title}
Category: {category}
Description: {description}
{acceptance_criteria}

## Output JSON only:
{"edges":[{"subject":"...","predicate":"...","object":"...","value":"optional detail"}]}`;

// --- Auth ---

let jwtToken = '';
let jwtExpiresAt = 0;

async function getJWT(): Promise<string> {
  if (jwtToken && Date.now() < jwtExpiresAt) return jwtToken;

  if (!STRAPI_USER || !STRAPI_PASSWORD) {
    throw new Error('Set STRAPI_USER and STRAPI_PASSWORD env vars');
  }

  const resp = await fetch(`${STRAPI_URL}/auth/local`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: STRAPI_USER, password: STRAPI_PASSWORD }),
  });
  if (!resp.ok) throw new Error(`Auth failed: ${resp.status}`);
  const data = (await resp.json()) as any;
  jwtToken = data.jwt;
  // Refresh 5 min before expiry (Strapi default is 30 days, but be safe)
  jwtExpiresAt = Date.now() + 25 * 24 * 60 * 60 * 1000;
  console.log('Authenticated as', data.user?.username);
  return jwtToken;
}

async function strapiGet(path: string): Promise<any> {
  const jwt = await getJWT();
  const resp = await fetch(`${STRAPI_URL}${path}`, {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!resp.ok) throw new Error(`GET ${path}: ${resp.status}`);
  return resp.json();
}

async function strapiPost(path: string, body: any): Promise<any> {
  const jwt = await getJWT();
  const resp = await fetch(`${STRAPI_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`POST ${path}: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

async function strapiPut(urlPath: string, body: any): Promise<any> {
  const jwt = await getJWT();
  const resp = await fetch(`${STRAPI_URL}${urlPath}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`PUT ${urlPath}: ${resp.status} ${text.slice(0, 200)}`);
  }
  return resp.json();
}

// --- LLM ---

async function callLLM(prompt: string): Promise<string> {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiUrl) throw new Error('LITELLM_API_URL not set');

  const fastModel = process.env.LITELLM_FAST_MODEL || process.env.LITELLM_MODEL || 'gemini-flash';
  const resp = await fetch(`${apiUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
    },
    body: JSON.stringify({
      model: fastModel,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 300,
      temperature: 0,
    }),
  });

  if (!resp.ok) throw new Error(`LLM ${resp.status}: ${await resp.text()}`);
  const data = (await resp.json()) as any;
  return (data.choices?.[0]?.message?.content || '').trim();
}

// --- Edge upsert via API ---

async function upsertEdge(
  projectDocId: string,
  edge: { subject: string; predicate: string; object: string; value?: string },
  issueDocId: string,
): Promise<boolean> {
  const qs = new URLSearchParams({
    'filters[project][documentId][$eq]': projectDocId,
    'filters[subject][$eq]': edge.subject,
    'filters[predicate][$eq]': edge.predicate,
    'filters[object][$eq]': edge.object,
    'filters[validUntil][$null]': 'true',
    'pagination[limit]': '1',
  });

  try {
    const existing = await strapiGet(`/knowledge-edges?${qs}`);
    const now = new Date().toISOString();

    if (existing.data?.length > 0) {
      await strapiPut(`/knowledge-edges/${existing.data[0].documentId}`, {
        data: {
          value: edge.value || existing.data[0].value,
          sourceMemoryId: `issue:${issueDocId}`,
          validFrom: now,
        },
      });
    } else {
      await strapiPost('/knowledge-edges', {
        data: {
          subject: edge.subject,
          predicate: edge.predicate,
          object: edge.object,
          value: edge.value || null,
          sourceMemoryId: `issue:${issueDocId}`,
          confidence: 1.0,
          validFrom: now,
          validUntil: null,
          project: projectDocId,
        },
      });
    }
    return true;
  } catch (err) {
    console.log(`    EDGE ERROR: ${err}`);
    return false;
  }
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1]) : 999;

  // Fetch all issues with descriptions from prod API (paginated)
  const issues: any[] = [];
  let page = 1;
  while (issues.length < limit) {
    const pageSize = Math.min(25, limit - issues.length);
    const qs = new URLSearchParams({
      'populate[project]': 'true',
      'pagination[page]': String(page),
      'pagination[pageSize]': String(pageSize),
      'sort': 'createdAt:desc',
    });
    const resp = await strapiGet(`/issues?${qs}`);
    const batch = resp.data || [];
    if (batch.length === 0) break;
    issues.push(...batch);
    if (batch.length < pageSize) break;
    page++;
  }

  // Filter to issues with meaningful descriptions
  const filtered = issues.filter(
    (i: any) => i.description && i.description.length > 30 && i.project?.documentId,
  );

  console.log(`\nFetched ${issues.length} issues, ${filtered.length} have descriptions > 30 chars`);
  if (dryRun) console.log('DRY RUN — no edges will be written\n');

  let totalEdges = 0;
  let emptyCount = 0;
  let errorCount = 0;

  for (let i = 0; i < filtered.length; i++) {
    const issue = filtered[i];
    const projectDocId = issue.project.documentId;

    const prompt = ISSUE_EDGE_PROMPT
      .replace('{title}', issue.title || '')
      .replace('{category}', issue.category || 'unknown')
      .replace('{description}', (issue.description || '').slice(0, 600))
      .replace(
        '{acceptance_criteria}',
        issue.acceptanceCriteria
          ? `Acceptance Criteria: ${issue.acceptanceCriteria.slice(0, 300)}`
          : '',
      );

    try {
      const raw = await callLLM(prompt);
      const jsonStr = raw.replace(/^```json?\s*/, '').replace(/\s*```$/, '');
      const parsed = JSON.parse(jsonStr) as { edges?: any[] };
      const edges = Array.isArray(parsed.edges) ? parsed.edges.slice(0, 5) : [];

      if (edges.length === 0) {
        console.log(`  [${i + 1}/${filtered.length}] ${issue.documentId} "${(issue.title || '').slice(0, 50)}" — no edges`);
        emptyCount++;
        continue;
      }

      console.log(`  [${i + 1}/${filtered.length}] ${issue.documentId} "${(issue.title || '').slice(0, 50)}"`);
      for (const e of edges) {
        if (!e.subject || !e.predicate || !e.object) continue;
        const s = String(e.subject).toLowerCase().trim();
        const p = String(e.predicate).toLowerCase().trim();
        const o = String(e.object).toLowerCase().trim();
        const v = e.value ? String(e.value) : undefined;

        console.log(`    ${s} —${p}→ ${o}${v ? `: ${v}` : ''}`);

        if (!dryRun) {
          await upsertEdge(projectDocId, { subject: s, predicate: p, object: o, value: v }, issue.documentId);
        }
        totalEdges++;
      }
    } catch (err) {
      console.log(`  [${i + 1}/${filtered.length}] ${issue.documentId} ERROR: ${err}`);
      errorCount++;
    }

    // Small delay to avoid rate limits
    if (i < filtered.length - 1) await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`BACKFILL SUMMARY`);
  console.log(`  Issues processed: ${filtered.length}`);
  console.log(`  Issues with edges: ${filtered.length - emptyCount - errorCount}`);
  console.log(`  Empty (no structural content): ${emptyCount}`);
  console.log(`  Errors: ${errorCount}`);
  console.log(`  Total edges ${dryRun ? 'found' : 'upserted'}: ${totalEdges}`);
}

main().catch(console.error);
