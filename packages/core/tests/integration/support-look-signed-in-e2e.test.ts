import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // the bot's token and the actors' secrets are sealed in the integration vault
  process.env.INTEGRATION_MASTER_KEY ??= Buffer.alloc(32, 5).toString('base64');
});

/**
 * The box a look opens, standing in for a browser on a device this world lacks: it holds the cookies
 * and storage it is told, and the app behind it shows its sign-in page to a browser holding no
 * session. Every act is kept as core sent it (`run`) and as the feed records it (`shown`).
 */
const fake = vi.hoisted(() => ({
  session: '',
  boxes: new Map<
    string,
    {
      projectId: string;
      createdBy: string;
      url: string;
      cookies: Map<string, string>;
      storage: Map<string, string>;
    }
  >(),
  acts: [] as { run: string[]; shown: string[] }[],
}));

vi.mock('../../src/boxes/index.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/boxes/index.js')>();
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const signedIn = (b: { cookies: Map<string, string> }) =>
    fake.session !== '' && b.cookies.get('sid') === fake.session;
  return {
    ...real,
    openBox: async (actor: { userId: string }, projectId: string, req: { url: string }) => {
      const id = randomUUID();
      fake.boxes.set(id, {
        projectId,
        createdBy: actor.userId,
        url: req.url,
        cookies: new Map(),
        storage: new Map(),
      });
      return { id };
    },
    boxById: async (id: string) => {
      const b = fake.boxes.get(id);
      return b ? { id, projectId: b.projectId, createdBy: b.createdBy, state: 'agent' } : null;
    },
    closeBox: async () => ({}),
    boxShot: async () => ({ ok: true, bytes: PNG, mime: 'image/png' }),
    agentAct: async (
      _actor: unknown,
      boxId: string,
      command: string[],
      _run?: string,
      shown?: string[],
    ) => {
      fake.acts.push({ run: command, shown: shown ?? command });
      const b = fake.boxes.get(boxId);
      if (!b) throw new Error(`no box ${boxId}`);
      const [verb, a = '', c = '', d = '', e = ''] = command;
      let stdout = '';
      if (verb === 'cookies' && a === 'set') b.cookies.set(c, d);
      if (verb === 'storage' && c === 'set') b.storage.set(d, e);
      if (verb === 'open') b.url = a;
      if (verb === 'get' && a === 'url')
        b.url = signedIn(b) ? b.url : `${new URL(b.url).origin}/login`;
      if (verb === 'get' && a === 'url') stdout = b.url;
      if (verb === 'snapshot') {
        stdout = signedIn(b)
          ? '- heading "Suppliers" [ref=e1]\n- link "Product Type Mapping" [ref=e2]'
          : '- heading "Sign in" [ref=e1]\n- textbox "Email" [ref=e2]';
      }
      if (verb === 'screenshot') stdout = '/tmp/agent-browser/shot.png';
      return { act: { state: 'done', exitCode: 0, stdout } };
    },
  };
});

import { api } from '../helpers/api.js';
import { rows } from '../helpers/factories.js';
import { seedProjectDocument } from '../helpers/release-world.js';
import type { StandInRocketChat } from '../helpers/support-chat-server.js';
import { SupportWorld } from '../helpers/support-world.js';

// @direct-test-of packages/core/src/support/look-act.ts
// @direct-test-of packages/core/src/support/look-session.ts
// @direct-test-of packages/core/src/support/reply-shots.ts
// @direct-test-of packages/core/src/support/service.ts
// @direct-test-of packages/core/src/project-config/look-sign-in.ts
// @direct-test-of packages/core/src/integrations/deploy/sign-in-probe.ts
//
// ISS-1386 (moved out of ISS-1356 c1): a room agent's look opened its browser box unsigned, so a
// screen behind sign-in showed its sign-in page, and its shot was a file on the box's device the
// person never saw. A first look on an environment naming a testing profile now signs in as one of
// its actors, through the path judges read the secret by, and the reply posts the look's picture in
// the look's own thread. The planted password reaches no answer, row or box act; the session reaches
// the box alone, shown in its feed as `[session]`.

vi.setConfig({ testTimeout: 90_000, hookTimeout: 120_000 });

const PASSWORD = 'Pl4nted-Viewer-Passw0rd-1386';
const ADMIN_PASSWORD = 'Pl4nted-Admin-Passw0rd-1386';
const SESSION = `sess-${randomUUID()}`;
const TOKEN = `jwt-${randomUUID()}`;
const ENV_URL = 'https://stg.shop.example.test';

const w = new SupportWorld();
let chat: StandInRocketChat;
let app: Server;
let appOrigin = '';
let refuseSignIn = false;

/** The product's sign-in: a session cookie and a token for the account's own password, else 401. */
async function startApp(): Promise<void> {
  app = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      const sent = JSON.parse(body || '{}') as { password?: string };
      const known = sent.password === PASSWORD || sent.password === ADMIN_PASSWORD;
      if (req.url !== '/api/auth/local' || !known || refuseSignIn) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 'INVALID_CREDENTIALS' } }));
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'set-cookie': `sid=${SESSION}; Path=/; HttpOnly; SameSite=Lax`,
      });
      res.end(JSON.stringify({ jwt: TOKEN }));
    });
  });
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', () => r()));
  const address = app.address();
  appOrigin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
}

async function seedProfile(): Promise<void> {
  const put = async (path: string, body: unknown) => {
    const res = await api(w.owner, 'PUT', `/api/projects/${w.projectId}/${path}`, body);
    expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
  };
  const route = `${appOrigin}/api/auth/local`;
  await put('secrets/qa/viewer', {
    value: JSON.stringify({ email: 'viewer@shop.test', password: PASSWORD, loginRoute: route }),
  });
  await put('secrets/qa/admin', {
    value: JSON.stringify({
      email: 'admin@shop.test',
      password: ADMIN_PASSWORD,
      loginRoute: route,
      storageKey: 'auth_token',
      storageOrigin: ENV_URL,
    }),
  });
  await put('testing-profiles/qa', {
    baseRevision: null,
    document: {
      $schema: 'https://forge.sidcorp.co/schemas/testing-profile-v1.json',
      version: 1,
      id: 'qa',
      actors: {
        admin: { role: 'project-admin', credential: 'secret://qa/admin' },
        viewer: { role: 'viewer', credential: 'secret://qa/viewer' },
      },
      services: {},
      limits: [],
    },
  });
  await seedProjectDocument(w.projectId, w.ownerId, {
    environments: {
      staging: {
        tier: 'staging',
        deploysFrom: 'main',
        deployment: { mode: 'external' },
        testing: 'qa',
        url: ENV_URL,
      },
    },
    extra: { contentLanguage: 'en' },
  });
}

type Acts = (args: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A member asks `ask`; the session runs `turn` on its thread. Answers what `turn` returned. */
async function inTurn<T>(ask: string, turn: (act: Acts, thread: string) => Promise<T>): Promise<T> {
  await w.settleWarm();
  let out: { value: T } | null = null;
  w.box.model = async (t, act) => {
    const m = t.messages.find((x) => x.from !== 'forge' && x.text === ask);
    if (!m) return;
    out = { value: await turn(act, m.thread) };
  };
  await chat.say(chat.bob, ask);
  await expect.poll(() => out, { timeout: 30_000 }).not.toBeNull();
  await w.settleWarm();
  w.box.model = async () => {};
  return (out as unknown as { value: T }).value;
}

/** What an act answered, refused or not, as text. */
const failed = async (act: Acts, args: Record<string, unknown>) => JSON.stringify(await act(args));

/** Everything core kept of this project's room: its actions, as text. */
const roomRows = async () =>
  JSON.stringify(
    await rows(
      sql`SELECT input, output FROM support_actions WHERE project_id = ${w.projectId}::uuid`,
    ),
  );

beforeAll(async () => {
  await startApp();
  await w.start();
  await seedProfile();
  await w.bind();
  chat = w.chat as StandInRocketChat;
  fake.session = SESSION;
}, 120_000);

afterAll(async () => {
  await w.stop();
  await new Promise((r) => app.close(r));
});

describe('a look signs in as a testing-profile actor, and its reply carries the shot (ISS-1386)', () => {
  it('reads a signed-in page, not its sign-in screen, and posts the shot in the thread', async () => {
    const text = 'The Product Type Mapping item is in the menu on the Suppliers page.';
    const { look, thread, replied } = await inTurn(
      'Where is the mapping menu?',
      async (act, thread) => {
        const look = await act({
          action: 'look',
          thread,
          environment: 'staging',
          path: '/settings/suppliers',
        });
        const replied = await act({ action: 'reply', thread, text, shots: [look.picture] });
        return { look, thread, replied };
      },
    );
    // the least privileged actor, signed in before the screen was read
    expect(look).toMatchObject({
      url: `${ENV_URL}/settings/suppliers`,
      signIn: { actor: 'viewer', signedIn: true, why: null },
    });
    expect(String(look.snapshot)).toContain('Suppliers');
    expect(String(look.snapshot)).not.toContain('Sign in');
    expect(look.picture).toMatch(/^[0-9a-f-]{36}$/);
    expect(replied, JSON.stringify(replied)).toMatchObject({ messageId: expect.any(String) });
    // the shot follows the text, in the asker's thread
    const lines = await w.untilLines((ls) => ls.some((l) => l.tmid === thread && l.file));
    const posted = lines.filter((l) => l.tmid === thread);
    expect(posted.map((l) => l.text)).toContain(text);
    expect(posted.find((l) => l.file)?.file?.mime).toBe('image/png');
    // the session went to the box as values, and its feed shows none of them
    const placed = fake.acts.filter((a) => a.run[0] === 'cookies');
    expect(placed.map((a) => a.run.slice(0, 4))).toEqual([['cookies', 'set', 'sid', SESSION]]);
    expect(JSON.stringify(fake.acts.map((a) => a.shown))).not.toContain(SESSION);
    expect(placed[0]?.shown).toContain('[session]');
    // the password reached no act, answer or row
    const everything = `${JSON.stringify(fake.acts)}${JSON.stringify(look)}${await roomRows()}`;
    expect(everything).not.toContain(PASSWORD);
    expect(await roomRows()).not.toContain(SESSION);
    expect(await roomRows()).toContain('"as":"viewer"');
  });

  it('signs in as the actor the agent names, writing the token where the secret says', async () => {
    fake.acts.length = 0;
    const look = await inTurn('Check the admin settings page', async (act, thread) => {
      const seen = await act({ action: 'look', thread, environment: 'staging', as: 'admin' });
      await act({ action: 'silent', thread, reason: 'test' });
      return seen;
    });
    expect(look).toMatchObject({ signIn: { actor: 'admin', signedIn: true } });
    expect(fake.acts.map((a) => a.shown)).toContainEqual([
      'storage',
      'local',
      'set',
      'auth_token',
      '[session]',
    ]);
    expect(fake.acts.map((a) => a.run)).toContainEqual(['open', ENV_URL]);
    expect(JSON.stringify(fake.acts.map((a) => a.shown))).not.toContain(TOKEN);
    expect(`${JSON.stringify(fake.acts)}${JSON.stringify(look)}`).not.toContain(ADMIN_PASSWORD);
  });

  it('refuses an actor the profile does not declare, naming those it does, and opens nothing', async () => {
    const before = fake.boxes.size;
    const said = await inTurn('Check it as the owner', async (act, thread) => {
      const out = await failed(act, {
        action: 'look',
        thread,
        environment: 'staging',
        as: 'owner',
      });
      await act({ action: 'silent', thread, reason: 'test' });
      return out;
    });
    expect(said).toContain('SUPPORT_LOOK_ACTOR_UNKNOWN');
    expect(said).toContain('it declares admin, viewer');
    expect(fake.boxes.size).toBe(before);
  });

  it('says why a sign-in that answers no session left the screen unsigned', async () => {
    refuseSignIn = true;
    try {
      const look = await inTurn('Is the export button there?', async (act, thread) => {
        const seen = await act({ action: 'look', thread, environment: 'staging' });
        await act({ action: 'silent', thread, reason: 'test' });
        return seen;
      });
      expect(look).toMatchObject({ signIn: { actor: 'viewer', signedIn: false } });
      expect(String((look.signIn as { why: string }).why)).toContain('answered 401');
      expect(String(look.snapshot)).toContain('Sign in');
      expect(JSON.stringify(look)).not.toContain(PASSWORD);
    } finally {
      refuseSignIn = false;
    }
  });

  it("refuses a shot no look of the reply's thread took, and posts nothing", async () => {
    const first = await inTurn('Show me the suppliers page', async (act, thread) => {
      const seen = await act({ action: 'look', thread, environment: 'staging' });
      await act({ action: 'silent', thread, reason: 'test' });
      return seen;
    });
    const said = await inTurn('And the orders page?', async (act, thread) => {
      const out = await failed(act, {
        action: 'reply',
        thread,
        text: 'Here it is.',
        shots: [first.picture],
      });
      await act({ action: 'silent', thread, reason: 'test' });
      return { out, thread };
    });
    expect(said.out).toContain('SUPPORT_REPLY_SHOT_UNKNOWN');
    expect(chat.linesIn(chat.rid).filter((l) => l.tmid === said.thread)).toEqual([]);
  });
});
