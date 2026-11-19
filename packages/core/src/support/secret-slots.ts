// The slot a secret link names, resolved for one project (ISS-1348): each kind's own field, and the
// key every write of it is told by (`secret.slotFilled`). The agent names the slot; core builds the
// link to its request on the project's Secrets page (`secret-link.ts`), so no agent writes a settings
// URL or picks a screen. A refusal names what the project declares instead, and nothing is recorded.

import { parseSecretRef } from '@forge/contracts/project-config';
import type { SupportSecretLinkRequest } from '@forge/contracts/support';
import {
  connectionSlotKey,
  credentialFieldOf,
  listBindingsForProject,
} from '../integrations/index.js';
import {
  declaredEnvironments,
  listSecretNames,
  listTestingProfiles,
  slotKeyOf,
  variableHeld,
} from '../project-config/index.js';
import { no, type Outcome } from './outcome.js';

/** The fields of the act that name a slot: the act's own, and the page's. */
export type SlotNamed = Pick<
  SupportSecretLinkRequest,
  'kind' | 'environment' | 'key' | 'profile' | 'actor' | 'service' | 'provider'
>;

export interface ResolvedSlot {
  kind: SupportSecretLinkRequest['kind'];
  slot: Record<string, string | null>;
  slotKey: string;
  /** Whether the slot holds a value now: its request opens on that, with nothing to do. */
  held: boolean;
}

/** The fields each kind takes; any other is refused by name, never ignored. */
const FIELDS: Record<SupportSecretLinkRequest['kind'], readonly string[]> = {
  variable: ['environment', 'key'],
  testing: ['profile', 'actor', 'service'],
  integration: ['provider'],
};
const SLOT_FIELDS = ['environment', 'key', 'profile', 'actor', 'service', 'provider'] as const;

function shapeRefused(input: SlotNamed): Outcome<never> | null {
  const takes = FIELDS[input.kind];
  const stray = SLOT_FIELDS.filter((f) => input[f] !== undefined && !takes.includes(f));
  const missing =
    input.kind === 'variable'
      ? (['environment', 'key'] as const).filter((f) => input[f] === undefined)
      : input.kind === 'testing'
        ? input.profile === undefined
          ? ['profile']
          : []
        : input.provider === undefined
          ? ['provider']
          : [];
  if (stray.length === 0 && missing.length === 0) return null;
  const said = [
    missing.length ? `it lacks ${missing.join(', ')}` : '',
    stray.length ? `it names ${stray.join(', ')}, which a ${input.kind} link does not take` : '',
  ]
    .filter(Boolean)
    .join(', and ');
  return no(
    'SUPPORT_SECRET_SLOT_SHAPE',
    `/${missing[0] ?? stray[0]}`,
    `a ${input.kind} secret link takes ${takes.join(', ')}${input.kind === 'variable' ? ' (environment null for every environment)' : input.kind === 'testing' ? ' (actor or service, one of them)' : ''}; ${said}. No link was made.`,
  );
}

async function variableSlot(
  project: { id: string; slug: string },
  environment: string | null,
  key: string,
): Promise<Outcome<ResolvedSlot>> {
  const declared = await declaredEnvironments(project.id);
  if (environment !== null && !declared.some((e) => e.name === environment)) {
    return no(
      'SUPPORT_SECRET_ENVIRONMENT_UNKNOWN',
      '/environment',
      `${project.slug} declares no environment ${environment}; it declares ${declared.map((e) => e.name).join(', ') || 'none'}, or null scopes the variable to every environment. No link was made.`,
    );
  }
  return {
    ok: true,
    value: {
      kind: 'variable',
      slot: { environment, key },
      slotKey: slotKeyOf({ projectId: project.id, key, environment }),
      held: await variableHeld(project.id, key, environment),
    },
  };
}

async function testingSlot(
  project: { id: string; slug: string },
  input: SlotNamed,
  stored: (ref: string) => Promise<boolean>,
): Promise<Outcome<ResolvedSlot>> {
  const profileId = input.profile ?? '';
  if ((input.actor === undefined) === (input.service === undefined)) {
    return no(
      'SUPPORT_SECRET_SLOT_ONE',
      '/actor',
      'a testing secret link opens one value: name the profile’s actor (it signs in) or its service (its key), one of them; no link was made',
    );
  }
  const profiles = await listTestingProfiles(project.id);
  const held = profiles.find((p) => p.profileId === profileId);
  if (!held) {
    const ids = profiles.map((p) => p.profileId);
    return no(
      'SUPPORT_SECRET_PROFILE_UNKNOWN',
      '/profile',
      `${project.slug} declares no testing profile ${profileId}; it declares ${ids.join(', ') || 'none'}. A profile is declared by a project admin; ask the master with support.ask_master. No link was made.`,
    );
  }
  const { actors, services } = held.document;
  // own keys only: a name such as `constructor` must not read the object's prototype
  const [slots, name] =
    input.actor !== undefined ? [actors, input.actor] : [services, input.service ?? ''];
  const declared = Object.hasOwn(slots, name) ? slots[name] : undefined;
  if (!declared) {
    const names = [
      ...Object.keys(actors).map((a) => `actor ${a}`),
      ...Object.keys(services).map((s) => `service ${s}`),
    ];
    const asked = input.actor !== undefined ? `actor ${input.actor}` : `service ${input.service}`;
    return no(
      'SUPPORT_SECRET_SLOT_UNKNOWN',
      input.actor !== undefined ? '/actor' : '/service',
      `testing profile ${profileId} declares no ${asked}; it declares ${names.join(', ') || 'none'}. One is declared on the profile by a project admin; ask the master with support.ask_master. No link was made.`,
    );
  }
  if (!parseSecretRef(declared.credential)) {
    const key = declared.credential.replace(/^var:\/\//, '');
    return no(
      'SUPPORT_SECRET_SLOT_VARIABLE',
      '/service',
      `service ${input.service} of testing profile ${profileId} takes its credential from the variable ${key}: ask for it with kind variable, key ${key} and the environment it is scoped to. No link was made.`,
    );
  }
  const slot = input.actor !== undefined ? { actor: input.actor } : { service: name };
  return {
    ok: true,
    value: {
      kind: 'testing',
      slot: { profile: profileId, ...slot, ref: declared.credential },
      slotKey: slotKeyOf({ projectId: project.id, key: declared.credential, environment: null }),
      held: await stored(declared.credential),
    },
  };
}

async function integrationSlot(
  project: { id: string; slug: string },
  provider: string,
): Promise<Outcome<ResolvedSlot>> {
  const bound = await listBindingsForProject(project.id);
  const connections = [
    ...new Map(
      bound
        .filter((b) => b.connection.provider === provider)
        .map((b) => [b.connection.id, b.connection]),
    ).values(),
  ];
  if (connections.length === 0) {
    const providers = [...new Set(bound.map((b) => b.connection.provider))].sort();
    return no(
      'SUPPORT_SECRET_INTEGRATION_UNKNOWN',
      '/provider',
      `${project.slug} binds no ${provider} connection; it binds ${providers.join(', ') || 'none'}. A connection is added by a project admin; ask the master with support.ask_master. No link was made.`,
    );
  }
  if (connections.length > 1) {
    const names = connections.map((c) => c.displayName ?? c.provider).join(', ');
    return no(
      'SUPPORT_SECRET_INTEGRATION_AMBIGUOUS',
      '/provider',
      `${project.slug} binds ${connections.length} ${provider} connections (${names}), so one link cannot say which; ask the master with support.ask_master. No link was made.`,
    );
  }
  const [connection] = connections as [(typeof connections)[number]];
  if (!credentialFieldOf(provider)) {
    return no(
      'SUPPORT_SECRET_INTEGRATION_NOT_BY_HAND',
      '/provider',
      `a ${provider} connection takes no credential a person types: it is installed or minted from its own page. Ask the master with support.ask_master. No link was made.`,
    );
  }
  return {
    ok: true,
    value: {
      kind: 'integration',
      slot: { provider, connection: connection.id },
      slotKey: connectionSlotKey(connection.id),
      held: connection.secretsEnc !== null,
    },
  };
}

/** The slot `input` names on `project`, or the refusal naming what it declares instead. */
export async function resolveSlot(
  project: { id: string; slug: string },
  input: SlotNamed,
): Promise<Outcome<ResolvedSlot>> {
  const shape = shapeRefused(input);
  if (shape) return shape;
  if (input.kind === 'variable') {
    return variableSlot(project, input.environment ?? null, input.key ?? '');
  }
  if (input.kind === 'testing') {
    const stored = async (ref: string) =>
      (await listSecretNames(project.id)).some((s) => s.ref === ref);
    return testingSlot(project, input, stored);
  }
  return integrationSlot(project, input.provider ?? '');
}
