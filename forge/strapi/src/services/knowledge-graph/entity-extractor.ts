/**
 * Unified entity + edge extraction from any source type (issue, memory, comment).
 * Single LLM call per source, fire-and-forget. Uses fast model for low cost.
 */

import { upsertEdge } from './edge-store';

export type EntityType = 'person' | 'project' | 'decision' | 'convention' | 'technology' | 'general';

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

export interface ExtractedEdge {
  subject: string;
  predicate: string;
  object: string;
  value?: string;
}

export interface ExtractionSource {
  type: 'issue' | 'memory' | 'comment';
  text: string;
  sourceId?: string;
  metadata?: { title?: string; category?: string; acceptanceCriteria?: string };
}

export interface ExtractionResult {
  entities: ExtractedEntity[];
  edges: ExtractedEdge[];
  edgesStored: number;
}

const EXTRACTION_PROMPT = `Extract entities and relationships from this {source_type}. Output structural connections only.

## Rules
- Extract named entities with their type: person, project, decision, convention, technology
- Extract subject→predicate→object triples that reveal project structure
- Preserve original language. Vietnamese stays Vietnamese.
- Max 8 entities, max 5 edges. If nothing structural, output {"entities":[],"edges":[]}
- Focus on: people/roles, features/modules, dependencies, rules/conventions, tech stack

## Entity types
- person: people, roles, teams (e.g. "Thanh", "HR admin", "frontend team")
- project: features, modules, pages, services (e.g. "/attendance", "auth module", "payroll")
- decision: architectural or product decisions (e.g. "use PageRank", "migrate to Postgres")
- convention: rules, patterns, standards (e.g. "kebab-case naming", "no direct DB queries")
- technology: tools, frameworks, libraries (e.g. "React", "Qdrant", "LiteLLM")

## Predicates
role_in, owns, depends_on, has_rule, has_convention, related_to, part_of, uses, affects, requires

## Good edges
- "Thanh" —owns→ "auth module": person owns a feature
- "/attendance" —has_rule→ "break hour deduction": page has a business rule
- "payroll" —depends_on→ "attendance data": feature dependency
- "auth module" —uses→ "JWT": feature uses a technology

## Bad edges (skip these)
- Generic: "user" —uses→ "system"
- Obvious: "issue" —related_to→ "project"
- Too specific: "ISS-175" —has_status→ "open"

## Input
{input_text}

## Output JSON only:
{"entities":[{"name":"...","type":"person|project|decision|convention|technology"}],"edges":[{"subject":"...","predicate":"...","object":"...","value":"optional detail"}]}`;

function formatInputText(source: ExtractionSource): string {
  const parts: string[] = [];

  if (source.metadata?.title) {
    parts.push(`Title: ${source.metadata.title}`);
  }
  if (source.metadata?.category) {
    parts.push(`Category: ${source.metadata.category}`);
  }

  parts.push(`Content: ${source.text.slice(0, 800)}`);

  if (source.metadata?.acceptanceCriteria) {
    parts.push(`Acceptance Criteria: ${source.metadata.acceptanceCriteria.slice(0, 300)}`);
  }

  return parts.join('\n');
}

/**
 * Extract entities and edges from a source using LLM.
 * Stores extracted edges via upsertEdge. Returns extraction result.
 * Designed to be called fire-and-forget for low latency.
 */
export async function extractEntitiesAndEdges(
  strapi: any,
  projectId: string,
  source: ExtractionSource,
): Promise<ExtractionResult> {
  const apiUrl = process.env.LITELLM_API_URL;
  const apiKey = process.env.LITELLM_API_KEY;
  if (!apiUrl) return { entities: [], edges: [], edgesStored: 0 };

  const text = source.text?.trim();
  if (!text || text.length < 30) {
    strapi.log.debug(`[knowledge-graph] skipping extraction for ${source.type}${source.sourceId ? ` [${source.sourceId}]` : ''}: text too short (${text?.length ?? 0} chars)`);
    return { entities: [], edges: [], edgesStored: 0 };
  }

  const prompt = EXTRACTION_PROMPT
    .replace('{source_type}', source.type)
    .replace('{input_text}', formatInputText(source));

  const fastModel = process.env.LITELLM_FAST_MODEL || process.env.LITELLM_MODEL || 'gemini-flash';

  const fetchExtraction = async (): Promise<Response> => {
    return fetch(`${apiUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey && { Authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify({
        model: fastModel,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 8192,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    });
  };

  let resp: Response;
  try {
    resp = await fetchExtraction();
  } catch (err: any) {
    strapi.log.warn(`[knowledge-graph] entity extraction fetch failed (attempt 1): ${err.message}${source.sourceId ? ` [${source.sourceId}]` : ''}`);
    // Retry once after 5s
    await new Promise((r) => setTimeout(r, 5000));
    try {
      resp = await fetchExtraction();
    } catch (retryErr: any) {
      strapi.log.warn(`[knowledge-graph] entity extraction fetch failed (attempt 2): ${retryErr.message}${source.sourceId ? ` [${source.sourceId}]` : ''}`);
      return { entities: [], edges: [], edgesStored: 0 };
    }
  }

  if (!resp.ok) {
    strapi.log.warn(`[knowledge-graph] entity extraction LLM failed: ${resp.status}${source.sourceId ? ` [${source.sourceId}]` : ''}`);
    // Retry once after 5s on server errors
    if (resp.status >= 500) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        resp = await fetchExtraction();
      } catch {
        return { entities: [], edges: [], edgesStored: 0 };
      }
      if (!resp.ok) {
        strapi.log.warn(`[knowledge-graph] entity extraction LLM retry failed: ${resp.status}${source.sourceId ? ` [${source.sourceId}]` : ''}`);
        return { entities: [], edges: [], edgesStored: 0 };
      }
    } else {
      return { entities: [], edges: [], edgesStored: 0 };
    }
  }

  const data = (await resp.json()) as any;
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  if (!raw) {
    strapi.log.warn(`[knowledge-graph] extraction returned empty response from ${source.type}${source.sourceId ? ` [${source.sourceId}]` : ''} (model: ${fastModel})`);
    return { entities: [], edges: [], edgesStored: 0 };
  }

  let parsed: { entities?: any[]; edges?: any[] };
  try {
    // Try direct parse first, then strip markdown code blocks, then extract JSON object from anywhere
    let jsonStr = raw;
    try {
      parsed = JSON.parse(jsonStr);
    } catch {
      jsonStr = raw.replace(/^```json?\s*/s, '').replace(/\s*```\s*$/s, '');
      try {
        parsed = JSON.parse(jsonStr);
      } catch {
        // Extract first JSON object from response (handles preamble text from LLMs)
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          parsed = JSON.parse(jsonMatch[0]);
        } else {
          throw new Error('No JSON object found');
        }
      }
    }
  } catch {
    strapi.log.warn(`[knowledge-graph] extraction parse failed from ${source.type}${source.sourceId ? ` [${source.sourceId}]` : ''} (model: ${fastModel}): ${raw.slice(0, 200)}`);
    return { entities: [], edges: [], edgesStored: 0 };
  }

  // Process entities
  const validTypes: EntityType[] = ['person', 'project', 'decision', 'convention', 'technology'];
  const entities: ExtractedEntity[] = (Array.isArray(parsed.entities) ? parsed.entities : [])
    .slice(0, 8)
    .filter((e: any) => e.name && typeof e.name === 'string')
    .map((e: any) => ({
      name: String(e.name).toLowerCase().trim(),
      type: validTypes.includes(e.type) ? e.type : 'general' as EntityType,
    }));

  // Process and store edges
  const rawEdges = Array.isArray(parsed.edges) ? parsed.edges.slice(0, 5) : [];
  const edges: ExtractedEdge[] = [];
  let edgesStored = 0;

  const sourceMemoryId = source.sourceId
    ? `${source.type}:${source.sourceId}`
    : undefined;

  for (const e of rawEdges) {
    if (!e.subject || !e.predicate || !e.object) continue;

    const edge: ExtractedEdge = {
      subject: String(e.subject).toLowerCase().trim(),
      predicate: String(e.predicate).toLowerCase().trim(),
      object: String(e.object).toLowerCase().trim(),
      value: e.value ? String(e.value) : undefined,
    };
    edges.push(edge);

    await upsertEdge(strapi, projectId, {
      subject: edge.subject,
      predicate: edge.predicate,
      object: edge.object,
      value: edge.value,
      sourceMemoryId,
    });
    edgesStored++;
  }

  if (entities.length > 0 || edgesStored > 0) {
    strapi.log.info(`[knowledge-graph] extracted ${entities.length} entities, ${edgesStored} edges from ${source.type}${source.sourceId ? ` ${source.sourceId}` : ''}`);
  } else {
    strapi.log.warn(`[knowledge-graph] extraction returned no entities/edges from ${source.type}${source.sourceId ? ` [${source.sourceId}]` : ''} (model: ${fastModel}, raw: ${raw.slice(0, 120)})`);
  }

  return { entities, edges, edgesStored };
}
