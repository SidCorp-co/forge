import {
  type ChangeKind,
  type ChangeLevel,
  type MeasuredChange,
  type MeasuredDiff,
  measured,
} from './diff.js';
import { OASDIFF_VERSION, type OasdiffEntry, runOasdiff } from './oasdiff.js';

const LEVELS: Readonly<Record<number, ChangeLevel>> = { 3: 'breaking', 2: 'warning', 1: 'info' };

export function kindOf(id: string): ChangeKind {
  if (/(^|-)(removed|deleted)(-|$)/.test(id)) return 'removed';
  if (/deprecat/.test(id)) return 'deprecated';
  if (/(^|-)added(-|$)/.test(id)) return 'added';
  return 'changed';
}

export function elementOf(e: Pick<OasdiffEntry, 'operation' | 'path' | 'section'>): string {
  if (e.operation && e.path) return `${e.operation.toUpperCase()} ${e.path}`;
  return e.path ?? e.section ?? 'document';
}

// cm:why an unknown level is not guessed into info: oasdiff printing a level this pin does not know is a differ that could not be read, which is unknown
export function fromChangelog(entries: readonly OasdiffEntry[]): MeasuredChange[] {
  return entries.map((e) => ({
    element: elementOf(e),
    kind: kindOf(e.id),
    level: LEVELS[e.level] ?? 'warning',
    text: e.text,
    check: e.id,
  }));
}

// cm:why oasdiff judges the OpenAPI vocabulary and reports no check for an x- extension; forge's validated and input markers describe a schema oasdiff already judged, while a gate, a refinement or a foreign extension changes what a caller may send in a way no check here can decide
const DESCRIPTIVE_EXTENSIONS = new Set(['x-forge-validated', 'x-forge-input', 'x-forge-generator']);

interface ExtensionDiff {
  added?: string[];
  deleted?: string[];
  modified?: Record<string, unknown>;
}

function extensionChanges(element: string, d: ExtensionDiff): MeasuredChange[] {
  const named: [string, ChangeKind][] = [
    ...(d.added ?? []).map((n): [string, ChangeKind] => [n, 'added']),
    ...(d.deleted ?? []).map((n): [string, ChangeKind] => [n, 'removed']),
    ...Object.keys(d.modified ?? {}).map((n): [string, ChangeKind] => [n, 'changed']),
  ];
  return named.map(([name, kind]) => ({
    element,
    kind,
    level: DESCRIPTIVE_EXTENSIONS.has(name) ? 'info' : 'warning',
    text: `the ${name} extension was ${kind === 'changed' ? 'changed' : kind}; oasdiff has no check for an extension, so what it means to a caller is not measured.`,
    check: 'forge-extension-changed',
  }));
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function fromStructural(diff: unknown): MeasuredChange[] {
  const out: MeasuredChange[] = [];
  const walk = (node: unknown, path: string | null, op: string | null, parents: string[]) => {
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const [p1, p2] = [parents.at(-1), parents.at(-2)];
      const nextPath = p1 === 'modified' && p2 === 'paths' ? key : path;
      const nextOp = p1 === 'modified' && p2 === 'operations' ? key : op;
      if (key === 'extensions' && isObject(value)) {
        const element = nextPath ? (nextOp ? `${nextOp} ${nextPath}` : nextPath) : 'document';
        out.push(...extensionChanges(element, value as ExtensionDiff));
        continue;
      }
      walk(value, nextPath, nextOp, [...parents, key]);
    }
  };
  walk(diff, null, null, []);
  return out;
}

export async function diffOpenApi(base: string, revision: string): Promise<MeasuredDiff> {
  const { changelog, structural } = await runOasdiff(base, revision);
  return measured('oasdiff', OASDIFF_VERSION, [
    ...fromChangelog(changelog),
    ...fromStructural(structural),
  ]);
}

export function openApiElements(doc: unknown): string[] {
  if (!isObject(doc) || !isObject(doc.paths)) return [];
  const methods = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  return Object.entries(doc.paths).flatMap(([path, item]) =>
    isObject(item)
      ? Object.keys(item)
          .filter((m) => methods.has(m))
          .map((m) => `${m.toUpperCase()} ${path}`)
      : [],
  );
}
