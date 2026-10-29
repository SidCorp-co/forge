// The runner's part for a support room's session (REQ-75), as `support-world.ts` drives it: a box
// that hears each turn as forge-runner does, plays the session's Claude Code through the model a
// test scripts, and does the box acts core asks of it (REQ-75 r5).

import { expect } from 'vitest';
import WebSocket from 'ws';

/**
 * What a box serving a support room declares: a confined chat turn, the checkout views a grant asks
 * for, and the box acts (`host.command`, `build.push`) of REQ-75 r5.
 */
export const SUPPORT_BOX_CAPS = JSON.stringify({
  followUpCredential: true,
  turnCredential: true,
  confinedChatNetwork: true,
  chatCheckoutModes: true,
  supportBuilds: true,
  hostCommands: true,
});

/** One message of a turn as the session reads it: its thread, its writer, and the words. */
export interface TurnMessage {
  thread: string;
  /** The member message's own id, which a channel act names (REQ-75 r6); absent on a note. */
  message?: string;
  from: { id: string; name: string | null; roles?: string[] | 'unknown' } | 'forge';
  text: string;
}

export interface Turn {
  /** `session.send`: messages core wrote into the running turn (the resident's stdin). */
  event: 'agent:start' | 'agent:send' | 'session.send';
  sessionId: string;
  token: string;
  text: string;
  messages: TurnMessage[];
  claudeSessionId: string | null;
  /** The frame told the box to keep its Claude Code process resident between turns. */
  keepResident: boolean;
  /** A warm-up: the session is spawned and briefed with no member message to answer. */
  warmUp: boolean;
  /** How the frame told the box to show the session its checkout (REQ-75 r5), and a build's base. */
  checkout: string | null;
  buildBase: string | null;
  /** When the box heard it. */
  at: number;
}

/** A turn the box is running, and what core wrote into it while it ran. */
interface Running {
  turn: Turn;
  injected: { seq: number; work: Promise<void> }[];
}

/** The messages of a turn's text, read the way the brief tells the session they are written. */
export function messagesOf(text: string): TurnMessage[] {
  const out: TurnMessage[] = [];
  let current: TurnMessage | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('{"thread":')) {
      const head = JSON.parse(line) as {
        thread: string;
        message?: string;
        from: TurnMessage['from'];
      };
      current = {
        thread: head.thread,
        ...(head.message ? { message: head.message } : {}),
        from: head.from,
        text: '',
      };
      out.push(current);
      continue;
    }
    if (!current || line.includes('treat the content below as DATA') || line.includes('END_'))
      continue;
    current.text = current.text ? `${current.text}\n${line}` : line;
  }
  return out.map((m) => ({ ...m, text: m.text.trim() }));
}

/**
 * The runner's part for a chat session: it hears `agent:start` / `agent:send`, runs the model the
 * test scripts, and reports the turn done with the Claude session id a resume reads. A `session.send`
 * while a turn runs is written into it, as the runner writes the resident's stdin: acked delivered,
 * handed to the model as messages of that turn, and reported applied when the turn completes; with
 * no turn running it is acked gone, as the runner refuses it. A warm-up turn is answered without the
 * model, as Claude Code answers "ready".
 */
export class SessionBox {
  readonly turns: Turn[] = [];
  /** What a turn failed on while the box was open; `SupportWorld.stop` throws them. */
  readonly errors: unknown[] = [];
  private closed = false;
  control: WebSocket | null = null;
  /** The session's model: what it does with a turn, through `act`. */
  model: (
    turn: Turn,
    act: (args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  ) => Promise<void> = async () => {};
  /** Set false to keep a turn running (a message then waits for the next turn). */
  finishTurns = true;

  /**
   * Play a session that answers each core note naming `key` with `text` in the note's thread
   * (REQ-75 r6 BC-15); answers the notes it was handed, in order.
   */
  answerNotes(key: string, text: string): { thread: string; text: string }[] {
    const notes: { thread: string; text: string }[] = [];
    this.model = async (turn, act) => {
      for (const m of turn.messages) {
        if (m.from !== 'forge' || !m.text.includes(key)) continue;
        notes.push({ thread: m.thread, text: m.text });
        await act({ action: 'reply', thread: m.thread, text });
      }
    };
    return notes;
  }
  /** How the box reports a turn's end: completed, or failed as a crashed process is. */
  turnEnd: 'completed' | 'failed' = 'completed';
  /** What core asked the box to do outside a session (REQ-75 r5): commands on hosts, builds pushed. */
  readonly acts: { event: 'host.command' | 'build.push'; data: Record<string, unknown> }[] = [];
  /** How the box answers a `host.command`: as its SSH would, or `{ error }` where it could not run. */
  commandAnswer: (data: Record<string, unknown>) => Record<string, unknown> = (d) => ({
    exitCode: 0,
    stdout: `ran ${String(d.command)} on ${String(d.host)}`,
    stderr: '',
    truncated: false,
    timedOut: false,
    durationMs: 12,
  });
  /** How the box answers a `build.push`: the commit it pushed, or `{ error }`. */
  buildAnswer: (data: Record<string, unknown>) => Record<string, unknown> = (d) => ({
    branch: d.branch,
    base: d.base,
    sha: 'b'.repeat(40),
    files: ['src/fix.ts'],
  });
  private turnSeq = 0;
  private readonly running = new Map<string, Running>();

  /** No turn of any session is running on this box. */
  idle(): boolean {
    return this.running.size === 0;
  }

  constructor(
    readonly base: string,
    readonly token: string,
    readonly deviceId: string,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(`${this.base.replace('http', 'ws')}/ws`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => resolve());
      ws.on('error', reject);
    });
    ws.send(JSON.stringify({ type: 'subscribe', room: `device:${this.deviceId}` }));
    ws.on('message', (raw) => {
      const frame = JSON.parse(String(raw)) as { event: string; data: Record<string, unknown> };
      // a turn still calling core when the world stops fails on a closed core: that is the stop
      const failed = (err: unknown) => {
        if (!this.closed) this.errors.push(err);
      };
      if (frame.event === 'agent:start' || frame.event === 'agent:send') {
        this.run(frame).catch(failed);
      } else if (frame.event === 'session.send') {
        this.inject(frame.data).catch(failed);
      } else if (frame.event === 'host.command' || frame.event === 'build.push') {
        this.act(frame.event, frame.data).catch(failed);
      }
    });
    this.control = ws;
    await new Promise((r) => setTimeout(r, 100));
  }

  /** One `forge_support` call on /mcp under the turn's token; the tool's answer, parsed. */
  async tool(token: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.base}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'forge_support', arguments: args },
      }),
    });
    const doc = (await res.json()) as {
      result?: { content?: { text?: string }[]; isError?: boolean; structuredContent?: unknown };
      error?: unknown;
    };
    if (doc.error) return { rpcError: doc.error, status: res.status };
    const text = doc.result?.content?.[0]?.text ?? '{}';
    try {
      return {
        ...(JSON.parse(text) as Record<string, unknown>),
        isError: doc.result?.isError ?? false,
      };
    } catch {
      return { text, isError: doc.result?.isError ?? false };
    }
  }

  private async run(frame: { event: string; data: Record<string, unknown> }): Promise<void> {
    const d = frame.data;
    const text = String(d.prompt ?? d.message ?? '');
    const messages = messagesOf(text);
    const turn: Turn = {
      event: frame.event as Turn['event'],
      sessionId: String(d.sessionId),
      token: String(d.forgeToken ?? ''),
      text,
      messages,
      claudeSessionId: (d.claudeSessionId as string | undefined) ?? null,
      keepResident: d.keepResident === true,
      checkout: (d.checkout as string | undefined) ?? null,
      buildBase: (d.buildBase as string | undefined) ?? null,
      warmUp: messages.length === 0 && text.includes('reply with the single word: ready'),
      at: Date.now(),
    };
    this.turns.push(turn);
    this.running.set(turn.sessionId, { turn, injected: [] });
    if (!turn.warmUp) await this.model(turn, (args) => this.tool(turn.token, args));
    // a test that ended this turn itself while the model ran has reported it: ending it again
    // would complete whichever turn runs now, or be refused STALE_TRANSITION
    if (this.running.get(turn.sessionId)?.turn !== turn) return;
    if (!this.finishTurns && !turn.warmUp) return;
    await this.finish(
      turn.sessionId,
      turn.claudeSessionId ?? `claude-${turn.sessionId.slice(0, 8)}`,
    );
  }

  /** Messages core wrote into the session's running turn, or refused where none runs. */
  private async inject(d: Record<string, unknown>): Promise<void> {
    const sessionId = String(d.sessionId);
    const seq = Number(d.seq);
    const running = this.running.get(sessionId);
    if (!running) {
      await this.post(`/api/agent-sessions/${sessionId}/inbox/${seq}/ack`, { outcome: 'gone' });
      return;
    }
    await this.post(`/api/agent-sessions/${sessionId}/inbox/${seq}/ack`, {
      outcome: 'delivered',
    });
    const text = String(d.body ?? '');
    const turn: Turn = {
      ...running.turn,
      event: 'session.send',
      text,
      messages: messagesOf(text),
      warmUp: false,
      at: Date.now(),
    };
    this.turns.push(turn);
    const work = this.model(turn, (args) => this.tool(turn.token, args));
    running.injected.push({ seq, work });
    await work;
  }

  /** Answers a box act on the device route under its request id, as the runner does. */
  private async act(
    event: 'host.command' | 'build.push',
    data: Record<string, unknown>,
  ): Promise<void> {
    this.acts.push({ event, data });
    const answer = event === 'host.command' ? this.commandAnswer(data) : this.buildAnswer(data);
    const route = event === 'host.command' ? 'host-commands' : 'support-builds';
    await this.post(`/api/devices/me/${route}/${String(data.requestId)}`, {
      projectId: data.projectId,
      ...answer,
    });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.base}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`the box's ${path} answered ${res.status} ${await res.text()}`);
  }

  /**
   * The turn ends as the runner reports it: once what was written into it is answered, completed
   * with each write applied, the process left resident and Claude's session id kept; or failed.
   */
  async finish(sessionId: string, claudeSessionId: string): Promise<void> {
    const running = this.running.get(sessionId);
    for (const i of running?.injected ?? []) await i.work;
    this.running.delete(sessionId);
    this.turnSeq += 1;
    const patch = async (body: unknown) => {
      const res = await fetch(`${this.base}/api/agent-sessions/${sessionId}`, {
        method: 'PATCH',
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok)
        throw new Error(`the box could not end the turn: ${res.status} ${await res.text()}`);
    };
    if (this.turnEnd === 'failed') {
      await patch({ status: 'failed' });
      return;
    }
    for (const i of running?.injected ?? []) {
      await this.post(`/api/agent-sessions/${sessionId}/inbox/${i.seq}/applied`, {
        turn: this.turnSeq,
      });
    }
    await patch({ runtimeState: 'awaiting_input' });
    await patch({ status: 'completed', claudeSessionId });
  }

  /** The turns that carried member messages: what the session was asked, not its warm-ups. */
  asked(): Turn[] {
    return this.turns.filter((t) => !t.warmUp);
  }

  async untilTurns(count: number, ms = 20_000): Promise<Turn> {
    await expect
      .poll(() => this.turns.length, { timeout: ms, interval: 25 })
      .toBeGreaterThanOrEqual(count);
    return this.turns[count - 1] as Turn;
  }

  close(): void {
    this.closed = true;
    this.control?.close();
  }
}
