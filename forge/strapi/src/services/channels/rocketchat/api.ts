interface RocketChatAuth {
  authToken: string;
  userId: string;
}

interface RocketChatMessage {
  _id: string;
  rid: string;
  msg: string;
  ts: string;
  u: { _id: string; username: string; name?: string };
  tmid?: string;
}

async function rcFetch(
  serverUrl: string,
  path: string,
  auth: RocketChatAuth,
  opts?: RequestInit,
): Promise<any> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${serverUrl}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'X-Auth-Token': auth.authToken,
        'X-User-Id': auth.userId,
        ...(opts?.headers ?? {}),
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Rocket.Chat API ${path} returned ${res.status}: ${body}`);
    }
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function login(
  serverUrl: string,
  username: string,
  password: string,
): Promise<RocketChatAuth> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${serverUrl}/api/v1/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: username, password }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Rocket.Chat login failed: ${res.status}`);
    const data = (await res.json()) as { data: { authToken: string; userId: string } };
    return { authToken: data.data.authToken, userId: data.data.userId };
  } finally {
    clearTimeout(timeout);
  }
}

export async function sendMessage(
  serverUrl: string,
  auth: RocketChatAuth,
  roomId: string,
  text: string,
  tmid?: string,
): Promise<void> {
  await rcFetch(serverUrl, '/api/v1/chat.sendMessage', auth, {
    method: 'POST',
    body: JSON.stringify({
      message: { rid: roomId, msg: text, ...(tmid ? { tmid } : {}) },
    }),
  });
}

export async function sendTypingIndicator(
  serverUrl: string,
  auth: RocketChatAuth,
  roomId: string,
  username: string,
  typing: boolean = true,
): Promise<void> {
  await rcFetch(serverUrl, `/api/v1/chat.reportTyping`, auth, {
    method: 'POST',
    body: JSON.stringify({ roomId, username, typing }),
  }).catch(() => {
    // Typing indicator is best-effort
  });
}

export async function getDirectMessageHistory(
  serverUrl: string,
  auth: RocketChatAuth,
  roomId: string,
  oldest?: string,
  count: number = 50,
): Promise<RocketChatMessage[]> {
  const params = new URLSearchParams({ roomId, count: String(count) });
  if (oldest) params.set('oldest', oldest);
  const data = await rcFetch(serverUrl, `/api/v1/dm.history?${params}`, auth);
  return data.messages ?? [];
}

export async function listDirectMessages(
  serverUrl: string,
  auth: RocketChatAuth,
): Promise<any[]> {
  const data = await rcFetch(serverUrl, '/api/v1/dm.list', auth);
  return data.ims ?? [];
}

export async function listJoinedChannels(
  serverUrl: string,
  auth: RocketChatAuth,
): Promise<any[]> {
  const data = await rcFetch(serverUrl, '/api/v1/channels.list.joined', auth);
  return data.channels ?? [];
}

export async function getChannelHistory(
  serverUrl: string,
  auth: RocketChatAuth,
  roomId: string,
  oldest?: string,
  count: number = 50,
): Promise<RocketChatMessage[]> {
  const params = new URLSearchParams({ roomId, count: String(count) });
  if (oldest) params.set('oldest', oldest);
  const data = await rcFetch(serverUrl, `/api/v1/channels.history?${params}`, auth);
  return data.messages ?? [];
}

export type { RocketChatAuth, RocketChatMessage };
