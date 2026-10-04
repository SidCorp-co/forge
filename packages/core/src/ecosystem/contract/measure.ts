import { createHash } from 'node:crypto';
import { refuseEcosystem } from '../refusals.js';
import { type MeasuredChange, type MeasuredDiff, measured } from './diff.js';
import { elementsOf, isIndexed } from './elements.js';
import { diffGraphql, GRAPHQL_RULES_VERSION } from './graphql-diff.js';
import { parseSdl, type SdlSchema } from './graphql-sdl.js';
import { diffMcpTools, toolsOf } from './mcp-tools-diff.js';
import { requireOasdiff } from './oasdiff.js';
import { diffOpenApi } from './openapi-diff.js';
import { diffJsonSchema, SCHEMA_RULES_VERSION } from './schema-diff.js';

export const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;

const unreadable = (detail: string) => refuseEcosystem('ARTIFACT_UNREADABLE', detail, '/artifact');

export const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export const INITIAL: MeasuredDiff = { tool: 'none', classification: 'initial', changes: [] };

export function parseArtifact(type: string, text: string): unknown {
  if (Buffer.byteLength(text, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw unreadable(`the artifact is over ${MAX_ARTIFACT_BYTES} bytes`);
  }
  if (!isIndexed(type)) return null;
  if (type === 'graphql') {
    return parseSdl(text);
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    throw unreadable(
      `a ${type} artifact is JSON, and this one does not parse (${err instanceof Error ? err.message : String(err)})`,
    );
  }
  if (type === 'mcp-tools' && !toolsOf(doc)) {
    throw unreadable(
      'an mcp-tools artifact is { tools: [{ name, description, inputSchema: { … } }] }, and this one is not',
    );
  }
  if (type === 'openapi' && (typeof doc !== 'object' || doc === null || !('openapi' in doc))) {
    throw unreadable('an openapi artifact names its openapi version, and this one names none');
  }
  return doc;
}

export const elementList = (type: string, doc: unknown): string[] | null =>
  isIndexed(type) ? elementsOf(type, doc).sort() : null;

const undecided = (type: string, why: string): MeasuredChange => ({
  element: 'document',
  kind: 'changed',
  level: 'warning',
  text: why,
  check: `${type}-not-measured`,
});

// cm:why a type with no differ, and a differ that ran and failed, are both measurements that could not decide, so they record unknown rather than refuse the land; only a differ that is absent refuses, because then nothing was measured at all
export async function measureChange(
  type: string,
  previous: string,
  next: string,
): Promise<MeasuredDiff> {
  if (type === 'openapi') {
    await requireOasdiff();
    try {
      return await diffOpenApi(previous, next);
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return measured('oasdiff', '', [
        undecided(type, `oasdiff could not compare the two versions: ${why}`),
      ]);
    }
  }
  if (type === 'mcp-tools') {
    const [o, n] = [toolsOf(JSON.parse(previous)), toolsOf(JSON.parse(next))];
    if (!o || !n) throw new Error('an mcp-tools artifact lost its tools list');
    return measured('json-schema-diff', SCHEMA_RULES_VERSION, diffMcpTools(o, n));
  }
  if (type === 'graphql') {
    return measured(
      'graphql-inspector',
      GRAPHQL_RULES_VERSION,
      await diffGraphql(
        parseArtifact(type, previous) as SdlSchema,
        parseArtifact(type, next) as SdlSchema,
      ),
    );
  }
  if (type === 'json-schema') {
    return measured(
      'json-schema-diff',
      SCHEMA_RULES_VERSION,
      diffJsonSchema(JSON.parse(previous), JSON.parse(next)),
    );
  }
  return measured('none', '', [
    undecided(type, `core has no differ for ${type} contracts, so the change is not measured`),
  ]);
}
