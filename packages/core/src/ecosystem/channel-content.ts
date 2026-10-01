import { scrubLogText } from '@forge/observability';
import type { EcosystemRefusal } from './refusals.js';
import type { InterfaceDocument } from './schema.js';

const CODE = /```|^\s{4}\S|\b(function|const|let|import|return|class|def)\b[^.]*[{(=]|=>|;\s*$/m;
const SECRET =
  /(eyJ[A-Za-z0-9_-]{10,}\.|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|postgres(ql)?:\/\/[^\s]*:[^\s]*@|password\s*[:=])/i;
const ISSUE_KEY = /\b[A-Z]{2,6}-\d+\b/g;
const PRESCRIBE =
  /\b(in your (code|repo|file)|you (must|should) (change|edit|modify|update) (your|the) (code|file|function|module))\b/i;
const FILE_PATH =
  /(?:^|[\s'"(`])(?:\.{1,2}\/)?(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|rs|py|go|java|kt|rb|php|cs|sql|json|ya?ml|toml|md|sh|css|html|lock)\b/;

const NOT_PROSE = new Set([
  'element',
  'contract',
  'contractVersion',
  'kind',
  'disposition',
  'classification',
  'urgency',
  'direction',
  'relatesTo',
  'requestedBy',
]);

export interface ProseAt {
  path: string;
  text: string;
}

// cm:why a contract-level example's payload is data the contract defines, and an element name is the contract's own word: neither is the sender's prose.
export function proseOf(body: unknown, at = '/body'): ProseAt[] {
  const out: ProseAt[] = [];
  const walk = (o: unknown, key: string, path: string) => {
    if (typeof o === 'string') {
      if (!NOT_PROSE.has(key) && !/^\d{4}-\d{2}-\d{2}/.test(o)) out.push({ path, text: o });
    } else if (Array.isArray(o)) {
      for (const [i, x] of o.entries()) walk(x, key, `${path}/${i}`);
    } else if (o && typeof o === 'object') {
      for (const [k, v] of Object.entries(o)) if (k !== 'payload') walk(v, k, `${path}/${k}`);
    }
  };
  walk(body, '', at);
  return out;
}

export function internalNamesOf(iface: InterfaceDocument): string[] {
  const names = new Set<string>();
  for (const pub of Object.values(iface.publishes)) {
    for (const m of pub.implementedBy ?? []) names.add(m);
    const path = pub.artifact && 'path' in pub.artifact ? pub.artifact.path : null;
    const dir = path?.includes('/') ? path.slice(0, path.lastIndexOf('/')) : null;
    if (dir) names.add(dir);
  }
  for (const c of iface.consumes) for (const m of c.usedBy ?? []) names.add(m);
  return [...names].sort();
}

const escapeRe = (s: string) => s.replace(/[/.\\^$*+?()[\]{}|-]/g, '\\$&');

export interface ContentContext {
  channelCode: string;
  internalNames: readonly string[] | null;
}

function scan(p: ProseAt, ctx: ContentContext): EcosystemRefusal[] {
  const out: EcosystemRefusal[] = [];
  const s = p.text;
  if (CODE.test(s)) {
    out.push({
      code: 'CONTENT_CODE',
      path: p.path,
      detail:
        'this reads as code (a code block, a statement or an arrow): a document states contract behaviour in plain language, and a payload goes in an example.',
    });
  }
  if (SECRET.test(s) || scrubLogText(s) !== s) {
    out.push({
      code: 'CONTENT_SECRET',
      path: p.path,
      detail:
        'this carries something shaped like a credential, token, private key or password; nothing secret crosses to another project, and the text is not echoed back.',
    });
  }
  if (PRESCRIBE.test(s)) {
    out.push({
      code: 'CONTENT_PRESCRIBES_IMPLEMENTATION',
      path: p.path,
      detail:
        'this tells the other side how to change its code; say what the contract now requires, and leave how to the side that owns the code.',
    });
  }
  const own = new RegExp(`\\b${escapeRe(ctx.channelCode)}-(CN|ACK|RFI|CR|DEC)-\\d+\\b`, 'g');
  const key = s.replace(own, '').match(ISSUE_KEY)?.[0];
  if (key) {
    out.push({
      code: 'CONTENT_INTERNAL_REF',
      path: p.path,
      detail: `"${key}" reads as an internal issue key; a document cites only numbers of this channel (${ctx.channelCode}-…), since the other side cannot open the sender's tracker.`,
    });
  }
  const file = FILE_PATH.exec(s)?.[0]?.trim();
  if (file) {
    out.push({
      code: 'CONTENT_INTERNAL_REF',
      path: p.path,
      detail: `"${file}" reads as a file path; the other side sees the contract, not the sender's tree.`,
    });
  }
  for (const n of ctx.internalNames ?? []) {
    if (new RegExp(`(^|[\\s'"(])${escapeRe(n)}(?=$|[\\s'").,/])`).test(s)) {
      out.push({
        code: 'CONTENT_INTERNAL_REF',
        path: p.path,
        detail: `"${n}" is one of the sender's internal modules or paths (named in its interface); describe the contract, not what implements it.`,
      });
      break;
    }
  }
  return out;
}

// cm:why fail-closed: with no interface core cannot tell the sender's internal names, so it refuses rather than let unscanned prose cross.
export function contentRefusals(
  subject: string,
  body: unknown,
  ctx: ContentContext,
): EcosystemRefusal[] {
  if (ctx.internalNames === null) {
    return [
      {
        code: 'CONTENT_INTERNAL_REF',
        path: '/from',
        detail:
          'the sending project has declared no interface, so core cannot tell its internal module names from contract words; declare the interface first, and nothing unscanned is sent.',
      },
    ];
  }
  return [{ path: '/subject', text: subject }, ...proseOf(body)].flatMap((p) => scan(p, ctx));
}
