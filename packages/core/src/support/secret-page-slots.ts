// Every secret a project holds, as its Secrets page lists them (ISS-1348, owner 2026-11-19: one home
// for every secret, grouped by what uses it): the app's secret and file variables per environment,
// each testing profile's accounts and services, the credentials of the connections it binds, and any
// other stored secret. A slot says whether it holds a value, when and through whom, never the value;
// its label is its key or name in plain words, the key itself secondary text.

import { createHash } from 'node:crypto';
import {
  type SecretForm,
  type SecretHeld,
  type SecretSlotGroup,
  type SecretSlotView,
  secretFormOf,
} from '@forge/contracts/secret-slots';
import { SUPPORT_OWNER_CREDENTIAL_SCOPE } from '@forge/contracts/support';
import { connectionSlotKey, credentialFieldOf, listBindingsForProject } from '../integrations/index.js';
import {
  declaredEnvironments,
  lastFills,
  listSecretNames,
  listTestingProfiles,
  listVariables,
  readProjectDocument,
  type SlotFill,
  slotKeyOf,
  type VariableRow,
} from '../project-config/index.js';

/** A slot's place on the page: stable for its slot, and no key or id as text. */
export const anchorOf = (slotKey: string) =>
  `slot-${createHash('sha256').update(slotKey).digest('hex').slice(0, 12)}`;

const ACRONYMS = new Set(['api', 'db', 'dsn', 'id', 'imap', 'ip', 'jwt', 'smtp', 'ssh', 'ssl', 'tls', 'url', 'aws', 's3']);

/** A key or name in plain words: `GOOGLE_CLIENT_ID` reads "Google client ID", `mail-support` "Mail support". */
export function labelOf(name: string): string {
  const words = name
    .split(/[_\-\s.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase())
    .map((w) => (ACRONYMS.has(w) ? w.toUpperCase() : w === 'oauth' ? 'OAuth' : w));
  const [first = name, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

export interface SlotStores {
  projectId: string;
  environments: { name: string; tier: string }[];
  variables: VariableRow[];
  fills: Map<string, SlotFill>;
  /** A person's name by account id. */
  names: Map<string, string>;
}

const heldOf = (s: SlotStores, at: Date, by: string | null, fill?: SlotFill): SecretHeld => {
  const who = fill?.by ?? by;
  return {
    at: (fill?.at ?? at).toISOString(),
    by: who ? (s.names.get(who) ?? null) : null,
    via: fill?.via ?? null,
  };
};

/** A variable slot, held or asked for: its row where the project holds one. */
export function variableSlot(
  s: SlotStores,
  key: string,
  environment: string | null,
  row: VariableRow | null,
  form?: SecretForm,
): SecretSlotView {
  const slotKey = slotKeyOf({ projectId: s.projectId, key, environment });
  return {
    anchor: anchorOf(slotKey),
    ref: { kind: 'variable', environment, key },
    label: labelOf(key),
    detail: key,
    environment,
    tier: s.environments.find((e) => e.name === environment)?.tier ?? null,
    door: {
      kind: 'variable',
      key,
      environment,
      variable: row ? { id: row.id, version: row.version } : null,
    },
    form: form ?? secretFormOf(row?.type === 'file' ? 'file' : 'value'),
    held: row ? heldOf(s, row.updatedAt, row.updatedBy, s.fills.get(slotKey)) : null,
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const SECRET_REF = /^secret:\/\/([^/]+)\/(.+)$/;

/** Each testing profile's accounts and services whose credential is a stored secret. */
async function testingGroups(
  s: SlotStores,
  stored: Map<string, { scope: string; name: string; updatedAt: Date }>,
): Promise<{ groups: SecretSlotGroup[]; named: Set<string> }> {
  const [profiles, doc] = await Promise.all([
    listTestingProfiles(s.projectId),
    readProjectDocument(s.projectId),
  ]);
  const envs = Object.entries(obj(doc?.document.environments));
  const named = new Set<string>();
  const groups = profiles.map((p): SecretSlotGroup => {
    const slots: SecretSlotView[] = [];
    const add = (kind: 'actor' | 'service', name: string, credential: string) => {
      const ref = SECRET_REF.exec(credential);
      if (!ref?.[1] || !ref[2]) return;
      named.add(credential);
      const held = stored.get(credential);
      const slotKey = slotKeyOf({ projectId: s.projectId, key: credential, environment: null });
      slots.push({
        anchor: anchorOf(slotKey),
        ref: { kind: 'testing', profile: p.profileId, [kind]: name },
        label: labelOf(name),
        detail: `${p.profileId} · ${name}`,
        environment: null,
        tier: null,
        door: { kind: 'secret', scope: ref[1], name: ref[2] },
        form: secretFormOf(kind === 'actor' ? 'signin' : 'value'),
        held: held ? heldOf(s, held.updatedAt, null, s.fills.get(slotKey)) : null,
      });
    };
    for (const [name, a] of Object.entries(p.document.actors)) add('actor', name, a.credential);
    for (const [name, v] of Object.entries(p.document.services)) add('service', name, v.credential);
    return {
      anchor: `testing-${p.profileId}`,
      kind: 'testing',
      name: p.profileId,
      usedIn: envs.filter(([, e]) => obj(e).testing === p.profileId).map(([n]) => n),
      tier: null,
      slots,
    };
  });
  return { groups, named };
}

/** The credential a person types for each connection the project binds; one typed by none is left out. */
async function connectionSlots(
  projectId: string,
  filledBy: (slotKey: string) => SecretHeld | null,
): Promise<SecretSlotView[]> {
  const bound = await listBindingsForProject(projectId);
  const connections = [...new Map(bound.map((b) => [b.connection.id, b.connection])).values()];
  return connections.flatMap((c): SecretSlotView[] => {
    const field = credentialFieldOf(c.provider);
    if (!field) return [];
    const slotKey = connectionSlotKey(c.id);
    const asked = filledBy(slotKey);
    return [
      {
        anchor: anchorOf(slotKey),
        ref: { kind: 'integration', provider: c.provider },
        label: c.displayName ?? labelOf(c.provider),
        detail: c.provider,
        environment: null,
        tier: null,
        door: { kind: 'connection', connection: c.id, field },
        form: secretFormOf('value'),
        held: c.secretsEnc
          ? (asked ?? { at: c.updatedAt.toISOString(), by: null, via: null })
          : null,
      },
    ];
  });
}

/** The stores a project's Secrets page reads, gathered once. */
export async function slotStoresOf(projectId: string): Promise<SlotStores> {
  const [environments, variables, fills] = await Promise.all([
    declaredEnvironments(projectId),
    listVariables(projectId),
    lastFills(projectId),
  ]);
  return { projectId, environments, variables, fills, names: new Map() };
}

/** Every group of the page, in the order a person reads them: the app, its tests, its connections, the rest. */
export async function slotGroups(
  s: SlotStores,
  filledBy: (slotKey: string) => SecretHeld | null,
  asked: SecretSlotView[],
): Promise<SecretSlotGroup[]> {
  const secrets = (await listSecretNames(s.projectId)).filter(
    (r) => r.scope !== SUPPORT_OWNER_CREDENTIAL_SCOPE,
  );
  const stored = new Map(secrets.map((r) => [r.ref, r]));
  const app = [
    ...s.variables
      .filter((v) => v.type !== 'plain')
      .map((v) => variableSlot(s, v.key, v.environment, v)),
    ...asked.filter((v) => v.ref?.kind === 'variable' && v.held === null),
  ];
  const scopes = [...s.environments.map((e) => e.name), null];
  const appGroups = scopes.flatMap((env): SecretSlotGroup[] => {
    const slots = app.filter((v) => v.environment === env);
    if (slots.length === 0) return [];
    const tier = s.environments.find((e) => e.name === env)?.tier ?? null;
    return [{ anchor: `app-${env ?? 'all'}`, kind: 'app', name: env, usedIn: [], tier, slots }];
  });
  const { groups: testing, named } = await testingGroups(s, stored);
  const connections = await connectionSlots(s.projectId, filledBy);
  const other = secrets
    .filter((r) => !named.has(r.ref))
    .map((r): SecretSlotView => {
      const slotKey = slotKeyOf({ projectId: s.projectId, key: r.ref, environment: null });
      return {
        anchor: anchorOf(slotKey),
        ref: null,
        label: labelOf(r.name),
        detail: `${r.scope} · ${r.name}`,
        environment: null,
        tier: null,
        door: { kind: 'secret', scope: r.scope, name: r.name },
        form: secretFormOf('value'),
        held: heldOf(s, r.updatedAt, null, s.fills.get(slotKey)),
      };
    });
  const tail = (kind: 'connections' | 'other', slots: SecretSlotView[]): SecretSlotGroup[] =>
    slots.length ? [{ anchor: kind, kind, name: null, usedIn: [], tier: null, slots }] : [];
  return [
    ...appGroups,
    ...testing.filter((g) => g.slots.length > 0),
    ...tail('connections', connections),
    ...tail('other', other),
  ];
}
