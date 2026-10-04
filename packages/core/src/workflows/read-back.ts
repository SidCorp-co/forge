import { HTTPException } from 'hono/http-exception';
import { envelopeOf } from '../lib/write-envelope.js';
import { isRecord } from '../project-config/index.js';
import type { WorkflowRefusal } from './rules.js';

export interface IgnoredField {
  path: string;
  detail: string;
}

type ReadBack =
  | { ok: true; baseRevision: number | null; document: unknown; ignored: IgnoredField[] }
  | { ok: false; refusals: WorkflowRefusal[] };

// what GET /api/projects/:id/workflows/:workflow wraps around the document, and stamps inside it
const BODY_FIELDS = ['revision', 'writer', 'writerName', 'design'] as const;
const STAMP_FIELDS = ['id', 'createdAt', 'updatedAt'] as const;

const shapeError = (message: string) =>
  new HTTPException(400, { message, cause: { code: 'CONFIG_WRITE_SHAPE' } });

/**
 * A PUT body is `{ baseRevision, document }`, and what GET returned is accepted as it stands: the
 * fields the server owns are dropped and reported, and `revision` is the base when no
 * `baseRevision` is sent.
 */
export function readBackOf(raw: unknown, workflowId: string): ReadBack {
  if (!isRecord(raw)) return { ok: true, ...envelopeOf(raw), ignored: [] };
  const ignored: IgnoredField[] = [];
  const body: Record<string, unknown> = { ...raw };
  for (const key of BODY_FIELDS) {
    if (!(key in body)) continue;
    delete body[key];
    ignored.push({
      path: `/${key}`,
      detail:
        key === 'revision'
          ? 'the revision the document was read at; it is the base when baseRevision is not sent'
          : 'owned by the server and set on every write',
    });
  }
  if ('revision' in raw) {
    if (!('baseRevision' in raw)) body.baseRevision = raw.revision;
    else if (raw.baseRevision !== raw.revision) {
      throw shapeError(
        `revision ${JSON.stringify(raw.revision)} and baseRevision ${JSON.stringify(raw.baseRevision)} disagree; send the one revision this write was read at`,
      );
    }
  }
  const document = body.document;
  if (isRecord(document)) {
    const stripped: Record<string, unknown> = { ...document };
    for (const key of STAMP_FIELDS) {
      if (!(key in stripped)) continue;
      if (key === 'id' && stripped.id !== workflowId) {
        return {
          ok: false,
          refusals: [
            {
              code: 'WORKFLOW_IDENTITY_IMMUTABLE',
              path: '/document/id',
              detail: `the document names workflow ${JSON.stringify(stripped.id)}, and this write is to ${workflowId}; a workflow keeps its id, and a document read from another workflow is written to that one.`,
            },
          ],
        };
      }
      delete stripped[key];
      ignored.push({
        path: `/document/${key}`,
        detail: 'owned by the server and set on every write',
      });
    }
    body.document = stripped;
  }
  return { ok: true, ...envelopeOf(body), ignored };
}
