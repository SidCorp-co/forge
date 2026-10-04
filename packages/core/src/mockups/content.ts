/**
 * The bytes a mockup is stored from: sent as base64, drawn as a wireframe-v1 document, or copied
 * from an upload already in the same project (an issue or comment attachment, which is where
 * `forge_uploads` puts a file). A copy is a new object in the one store, so a later delete of the
 * source never takes a mockup with it.
 */

import type { SensitiveDataLevel } from '@forge/contracts/data-policy';
import {
  MOCKUP_KIND_MIMES,
  type MockupKind,
  type ProposeMockupRequest,
} from '@forge/contracts/mockups';
import { parseWireframe } from '@forge/contracts/wireframe';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { commentAttachments, comments, issueAttachments, issues } from '../db/schema.js';
import { looksBinary, mimeFromName, safeName } from '../lib/attachment-mime.js';
import { storedText } from '../lib/data-egress.js';
import { getStorage } from '../storage/index.js';
import {
  contentRefusal,
  type MockupRefusal,
  sizeRefusal,
  sourceProjectRefusal,
  typeRefusal,
} from './rules.js';

export interface MockupContent {
  kind: MockupKind;
  name: string;
  mime: string;
  bytes: Buffer;
  caption: string | null;
}

export type MockupContentOutcome =
  | { ok: true; content: MockupContent }
  | { ok: false; refusals: MockupRefusal[] };

interface SourceRow {
  projectId: string;
  name: string;
  mime: string;
  path: string;
}

async function sourceRow(
  from: NonNullable<ProposeMockupRequest['source']>['from'],
  attachmentId: string,
): Promise<SourceRow | null> {
  if (from === 'issue') {
    const [row] = await db
      .select({
        projectId: issues.projectId,
        name: issueAttachments.name,
        mime: issueAttachments.mime,
        path: issueAttachments.path,
      })
      .from(issueAttachments)
      .innerJoin(issues, eq(issues.id, issueAttachments.issueId))
      .where(eq(issueAttachments.id, attachmentId));
    return row ?? null;
  }
  const [row] = await db
    .select({
      projectId: issues.projectId,
      name: commentAttachments.name,
      mime: commentAttachments.mime,
      path: commentAttachments.path,
    })
    .from(commentAttachments)
    .innerJoin(comments, eq(comments.id, commentAttachments.commentId))
    .innerJoin(issues, eq(issues.id, comments.issueId))
    .where(eq(commentAttachments.id, attachmentId));
  return row ?? null;
}

function candidateMime(kind: MockupKind, declared: string | undefined, name: string): string {
  if (declared) return declared;
  const guessed = mimeFromName(name);
  if (MOCKUP_KIND_MIMES[kind].includes(guessed)) return guessed;
  if (name.toLowerCase().endsWith('.html') || name.toLowerCase().endsWith('.htm'))
    return 'text/html';
  if (name.toLowerCase().endsWith('.svg')) return 'image/svg+xml';
  return MOCKUP_KIND_MIMES[kind][0] ?? guessed;
}

function bytesRefusal(kind: MockupKind, mime: string, bytes: Buffer): MockupRefusal | null {
  const sized = sizeRefusal(kind, bytes.length);
  if (sized) return sized;
  const typed = typeRefusal(kind, mime);
  if (typed) return typed;
  if (kind === 'image' || kind === 'sketch') return null;
  if (mime !== 'image/svg+xml' && looksBinary(bytes)) {
    return typeRefusal(kind, mime, `the bytes are binary, and a ${kind} mockup carries text`);
  }
  if (kind === 'wireframe') {
    let doc: unknown;
    try {
      doc = JSON.parse(bytes.toString('utf8'));
    } catch {
      return typeRefusal(kind, mime, 'the bytes are not JSON');
    }
    const parsed = parseWireframe(doc);
    if (!parsed.ok)
      return typeRefusal(kind, mime, `the board is not wireframe-v1 (${parsed.message})`);
  }
  if (kind === 'api_example' && mime === 'application/json') {
    try {
      JSON.parse(bytes.toString('utf8'));
    } catch {
      return typeRefusal(
        kind,
        mime,
        'the bytes are not JSON; send an HTTP transcript as text/plain',
      );
    }
  }
  return null;
}

// cm:guard the caption and the file name are the mockup's only text an agent reads in a manifest, so
// on a redact or no_egress project both are scrubbed on write (`storedText`); the bytes are never
// scrubbed and are withheld from agents instead (surface `mockup.content`, operational)
export async function mockupContent(
  projectId: string,
  level: SensitiveDataLevel,
  input: ProposeMockupRequest,
): Promise<MockupContentOutcome> {
  const early = contentRefusal(input);
  if (early) return { ok: false, refusals: [early] };
  let name: string;
  let mime: string;
  let bytes: Buffer;
  if (input.source) {
    const row = await sourceRow(input.source.from, input.source.attachmentId);
    const foreign = sourceProjectRefusal(
      input.source.from,
      input.source.attachmentId,
      row?.projectId ?? null,
      projectId,
    );
    if (foreign || !row) return { ok: false, refusals: foreign ? [foreign] : [] };
    name = input.name ?? row.name;
    mime = input.mime ?? row.mime;
    bytes = await getStorage().get(row.path);
  } else if (input.document !== undefined) {
    name = input.name ?? `board-${Date.now()}.wireframe.json`;
    bytes = Buffer.from(JSON.stringify(input.document, null, 2), 'utf8');
    mime = 'application/json';
  } else {
    name = input.name ?? '';
    bytes = Buffer.from(input.contentBase64 ?? '', 'base64');
    mime = candidateMime(input.kind, input.mime, name);
  }
  const wrong = bytesRefusal(input.kind, mime, bytes);
  if (wrong) return { ok: false, refusals: [wrong] };
  const caption = input.caption?.trim() ? storedText(level, input.caption.trim()).text : null;
  return {
    ok: true,
    content: {
      kind: input.kind,
      name: safeName(storedText(level, name).text),
      mime,
      bytes,
      caption,
    },
  };
}
