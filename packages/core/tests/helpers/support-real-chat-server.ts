// A real Rocket.Chat a support group (REQ-75) test can run against instead of the stand-in, named by
// SUPPORT_E2E_RC — the path of a JSON file
// `{ url, rid, bot: { userId, authToken }, members: { alice: { userId, authToken, username }, bob: … } }`.

import { readFileSync } from 'node:fs';
import type { BotLine, ChatServer, Member } from './support-chat-server.js';

/** A real Rocket.Chat, read from the file SUPPORT_E2E_RC names. */
export class RealRocketChat implements ChatServer {
  readonly serverUrl: string;
  readonly rid: string;
  readonly bot: { userId: string; authToken: string };
  readonly alice: Member;
  readonly bob: Member;
  private readonly since = new Date();

  constructor(file: string) {
    const c = JSON.parse(readFileSync(file, 'utf8')) as {
      url: string;
      rid: string;
      bot: { userId: string; authToken: string };
      members: { alice: Member; bob: Member };
    };
    this.serverUrl = c.url;
    this.rid = c.rid;
    this.bot = c.bot;
    this.alice = c.members.alice;
    this.bob = c.members.bob;
  }

  private async call(as: { userId: string; authToken?: string }, path: string, body?: unknown) {
    const res = await fetch(`${this.serverUrl}/api/v1/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'X-User-Id': as.userId,
        'X-Auth-Token': as.authToken ?? '',
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok || json.success === false) throw new Error(`${path} answered ${res.status}`);
    return json;
  }

  async say(who: Member, text: string, tmid?: string): Promise<string> {
    const out = await this.call(who, 'chat.postMessage', {
      roomId: this.rid,
      text,
      ...(tmid ? { tmid } : {}),
    });
    return (out.message as { _id: string })._id;
  }

  async botLines(): Promise<BotLine[]> {
    const q = new URLSearchParams({
      roomId: this.rid,
      count: '200',
      oldest: this.since.toISOString(),
    });
    const out = await this.call(this.bot, `groups.history?${q}`);
    const messages = out.messages as {
      _id: string;
      msg: string;
      tmid?: string;
      u: { _id: string };
      attachments?: BotLine['attachments'];
    }[];
    return messages
      .filter((m) => m.u._id === this.bot.userId)
      .reverse()
      .map((m) => ({
        id: m._id,
        text: m.msg,
        tmid: m.tmid ?? null,
        attachments: m.attachments ?? [],
      }));
  }

  async close(): Promise<void> {}
}
