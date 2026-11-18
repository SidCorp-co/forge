// `secret_link`: the door a room agent gives a person who wants a credential used (ISS-1328). The
// scrubber rightly keeps a secret posted in chat out of Forge (BC-40), and the agent could only
// refuse, so the owner did the setup himself. The link opens the project's Testing settings at the
// one actor or service of the testing profile it names, with its value field open: the person enters
// it there, it is kept as that slot's `secret://` (the project's secrets door, `PUT
// /api/projects/:id/secrets/:scope/:name`, which a project admin writes), and the master reads it at
// the testing-profile secrets door (`qa-guide.ts`). The value never passes through chat, a turn or a
// transcript. Core posts nothing: the session gives the link in its own words.

import type { SupportSecretLinkRequest } from '@forge/contracts/support';
import { webBaseUrl } from '../lib/web-base-url.js';
import { listTestingProfiles } from '../project-config/index.js';
import { namedProject } from './ops-scope.js';
import { knownThread, no, type Outcome, threadUnknown } from './outcome.js';
import type { RoomRow } from './store.js';

export interface SecretLink {
  link: string;
  profile: string;
  slot: { actor: string } | { service: string };
  /** Who the link opens a value field for: the page writes through the project's secrets door. */
  opensFor: string;
  says: string;
}

const SECRET_REF = /^secret:\/\//;

/** The Testing settings of `slug`, at the one slot named, with its value field open. */
export function secretLinkOf(
  web: string,
  slug: string,
  profile: string,
  slot: { actor: string } | { service: string },
): string {
  const [kind, name] = 'actor' in slot ? ['actor', slot.actor] : ['service', slot.service];
  const query = new URLSearchParams({ tab: 'testing', profile, [kind]: name });
  return `${web}/projects/${slug}/settings?${query.toString()}#profile-${profile}`;
}

export async function secretLink(
  room: RoomRow,
  input: SupportSecretLinkRequest,
): Promise<Outcome<SecretLink>> {
  if (!(await knownThread(room, input.thread))) return threadUnknown(input.thread);
  if ((input.actor === undefined) === (input.service === undefined)) {
    return no(
      'SUPPORT_SECRET_SLOT_ONE',
      '/actor',
      'a secret link opens one value: name the profile’s actor (it signs in) or its service (its key), one of them; no link was made',
    );
  }
  const profiles = await listTestingProfiles(room.projectId);
  const held = profiles.find((p) => p.profileId === input.profile);
  if (!held) {
    const ids = profiles.map((p) => p.profileId);
    return no(
      'SUPPORT_SECRET_PROFILE_UNKNOWN',
      '/profile',
      `this project declares no testing profile ${input.profile}; it declares ${ids.join(', ') || 'none'}. A profile is declared by a project admin; ask the master with support.ask_master. No link was made.`,
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
      `testing profile ${input.profile} declares no ${asked}; it declares ${names.join(', ') || 'none'}. One is declared on the profile by a project admin; ask the master with support.ask_master. No link was made.`,
    );
  }
  if (!SECRET_REF.test(declared.credential)) {
    return no(
      'SUPPORT_SECRET_SLOT_VARIABLE',
      '/service',
      `service ${input.service} of testing profile ${input.profile} takes its credential from a stored variable, which the project's variables hold, not a secret a person enters; ask the master with support.ask_master. No link was made.`,
    );
  }
  const web = webBaseUrl();
  if (!web) {
    return no(
      'SUPPORT_SECRET_LINK_NO_WEB',
      '',
      'this Forge knows no address of its web app (CORS_ORIGINS is unset), so it has no page to link to; ask the master with support.ask_master. No link was made.',
    );
  }
  const project = await namedProject(room, undefined);
  if (!project.ok) return project;
  const slot =
    input.actor !== undefined ? { actor: input.actor } : { service: input.service ?? '' };
  return {
    ok: true,
    value: {
      link: secretLinkOf(web, project.value.slug, input.profile, slot),
      profile: input.profile,
      slot,
      opensFor: `a person signed in to Forge who edits ${project.value.slug}'s settings: an owner or admin of its organization`,
      says: 'Give this link in the same line that says the secret was not kept: it opens a field where the person enters the value, kept in Forge’s vault for this profile, which the master reads from there. Never ask for it in chat, and never ask anyone to rotate it.',
    },
  };
}
