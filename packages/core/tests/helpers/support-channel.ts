// A bound group's channel record (REQ-75 r6), driven over support-world's room: a member writes,
// the session runs one act on that message, and the record reads back over the person doors.

import { expect } from 'vitest';
import { api } from './api.js';
import { type Member, SupportWorld, type Turn, type TurnMessage } from './support-world.js';

export type Act = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

export const carol: Member = { userId: 'u-carol', username: 'carol' };

/** The refusal code a tool answer carries, or undefined for one that stood. */
export const code = (out: Record<string, unknown> | undefined) => {
  const error = out?.error as { code?: string; refusals?: { code: string }[] } | undefined;
  return error?.refusals?.[0]?.code ?? error?.code;
};

export class ChannelWorld extends SupportWorld {
  rid = '';
  roomId = '';

  /** The world bound and warm, its one room read. */
  async open(): Promise<void> {
    await this.start();
    await this.bind();
    const [room] = await this.rooms();
    this.rid = String(room?.rid);
    this.roomId = String(room?.id);
  }

  base(): string {
    return `/api/projects/${this.projectId}/support/channels`;
  }

  /**
   * `who` writes `text` (in `tmid` when given); the session runs `does` on that message once and
   * its answer comes back. Every other message of the turn is left alone.
   */
  async ask(
    who: Member,
    text: string,
    does: (m: TurnMessage, act: Act) => Promise<Record<string, unknown> | undefined>,
    tmid?: string,
  ): Promise<{ id: string; out: Record<string, unknown> | undefined; turn: Turn }> {
    let out: Record<string, unknown> | undefined;
    let seen: Turn | undefined;
    let done = false;
    this.box.model = async (turn, act) => {
      for (const m of turn.messages) {
        // a posted secret reaches the session scrubbed, so a message is known by its opening words
        if (m.from === 'forge' || !m.text.startsWith(text.slice(0, 16))) continue;
        seen = turn;
        out = await does(m, act as Act);
        done = true;
      }
    };
    const id = await this.chat.say(who, text, tmid);
    await expect.poll(() => done, { timeout: 20_000 }).toBe(true);
    await this.settleWarm();
    return { id, out, turn: seen as Turn };
  }

  async channel(): Promise<Record<string, unknown>> {
    const got = await api(this.owner, 'GET', `${this.base()}/${this.rid}`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    return got.body.channel as Record<string, unknown>;
  }

  async memberRow(u: string): Promise<Record<string, unknown> | undefined> {
    return ((await this.channel()).memberRows as Record<string, unknown>[]).find(
      (m) => m.username === u,
    );
  }

  /** A person's correction of a member, as the channel's page writes it. */
  confirm(u: string, body: Record<string, unknown>) {
    return api(this.owner, 'PUT', `${this.base()}/${this.rid}/members/${u}`, body);
  }
}
