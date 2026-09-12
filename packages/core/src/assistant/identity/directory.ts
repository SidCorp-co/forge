/**
 * ISS-977 — ask a channel who one of its own speakers is.
 *
 * A link is proposed on the address the CHANNEL reports, never on one the
 * caller typed, so this is where a `(source, externalId)` pair becomes a
 * profile and a namespace. The namespace is the channel INSTANCE: a Rocket.Chat
 * user id is unique only within one installation, so the server the credential
 * points at is part of the identity and is read from the connection rather than
 * from the request.
 */

import type { ChatSessionSource } from '../../db/schema.js';
import { fetchUserProfile } from '../../integrations/rocketchat/rest-client.js';
import type { RocketChatConfig, RocketChatSecrets } from '../../integrations/rocketchat/types.js';
import {
  decryptConnectionSecrets,
  effectiveConfig,
  listActiveBindingsForProjectProvider,
} from '../../integrations/store.js';
import { isChatSessionSource, type SpeakerRefusal, sourceUnknownRefusal } from './speaker-link.js';

export interface SpeakerProfile {
  source: ChatSessionSource;
  namespace: string;
  externalId: string;
  username: string | null;
  email: string | null;
}

export type SpeakerLookup =
  | { found: true; profile: SpeakerProfile }
  | { found: false; refusal: SpeakerRefusal };

/**
 * The channel instance an external id belongs to, as a stable string: the
 * server's lowercased host and port, plus the base path it is served under,
 * with the scheme and any trailing slash dropped.
 */
// cm:guard host, port AND base path — dropping the path collapses two installations sharing a host (`/team-a`, `/team-b`) onto one namespace, which hands one installation's confirmed row the other's speaker of the same id; a trailing slash is stripped so one installation spelled two ways stays ONE namespace
export function namespaceFromServerUrl(serverUrl: string): string | null {
  try {
    const url = new URL(serverUrl);
    const host = url.host.toLowerCase();
    if (!host) return null;
    const base = url.pathname.replace(/\/+$/, '');
    return base ? `${host}${base}` : host;
  } catch {
    return null;
  }
}

function unsupported(source: string, why: string): SpeakerLookup {
  return {
    found: false,
    refusal: { code: 'SPEAKER_DIRECTORY_UNSUPPORTED', message: `${source}: ${why}` },
  };
}

/**
 * Look a speaker up through the project's own channel connection.
 *
 * The project is the credential's scope and not the map's — the link this
 * profile leads to is keyed on the channel instance, so it resolves for every
 * project reading the same installation.
 */
export async function lookupSpeakerProfile(args: {
  projectId: string;
  source: string;
  externalId: string;
}): Promise<SpeakerLookup> {
  const { projectId, source, externalId } = args;
  if (!isChatSessionSource(source)) {
    return { found: false, refusal: sourceUnknownRefusal(source) };
  }
  // cm:guard refuse each unimplemented channel BY NAME rather than falling through to one handler that guesses. `telegram` and `widget` are vocabulary with no code behind them (ISS-977 out of scope), and `web` speakers are sessions that already carry a userId — treating any of the three as Rocket.Chat would read a credential that has nothing to say about them.
  if (source === 'web') {
    return unsupported(
      source,
      'a web speaker is a signed-in session and already carries a Forge userId; there is no external directory to link against.',
    );
  }
  if (source === 'widget' || source === 'telegram') {
    return unsupported(
      source,
      'this channel has no implementation yet, so there is no directory to read a speaker from. Link speakers on a channel that is connected.',
    );
  }
  const [pair] = await listActiveBindingsForProjectProvider(projectId, 'rocketchat');
  if (!pair) {
    return {
      found: false,
      refusal: {
        code: 'SPEAKER_DIRECTORY_UNREACHABLE',
        message:
          'this project has no active Rocket.Chat binding, so no server can be asked who that speaker is. Connect Rocket.Chat to the project first.',
      },
    };
  }
  const config = effectiveConfig<RocketChatConfig>(pair);
  const secrets = decryptConnectionSecrets<RocketChatSecrets>(pair.connection);
  const namespace = namespaceFromServerUrl(config.serverUrl ?? '');
  if (!namespace || !secrets.authToken || !secrets.userId) {
    return {
      found: false,
      refusal: {
        code: 'SPEAKER_DIRECTORY_UNREACHABLE',
        message:
          "this project's Rocket.Chat connection is missing a usable server URL or bot credential, so its directory cannot be read.",
      },
    };
  }
  const profile = await fetchUserProfile(
    { serverUrl: config.serverUrl, authToken: secrets.authToken, userId: secrets.userId },
    externalId,
  );
  if (!profile) {
    return {
      found: false,
      refusal: {
        code: 'SPEAKER_NOT_ON_CHANNEL',
        message: `Rocket.Chat on ${namespace} returned no account for speaker id ${externalId}. Either the id is wrong, or the bot lacks the view-full-other-user-info permission it needs to read accounts.`,
      },
    };
  }
  return {
    found: true,
    profile: {
      source,
      namespace,
      externalId: profile.externalId,
      username: profile.username,
      email: profile.email,
    },
  };
}
