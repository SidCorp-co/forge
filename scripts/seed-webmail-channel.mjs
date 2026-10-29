#!/usr/bin/env node
// Seeds #webmail's channel record in Forge (REQ-75 r6, ISS-750 + ISS-751): the owner's member seed,
// every member confirmed, and the channel rules that until now lived in sidcorp-mail's hand-written
// watch prompt. It writes through the person doors a project admin uses on the channel's page, so a
// member it sets is confirmed and the bot never writes over it. Run it once the release carrying the
// channel record is live; running it again changes nothing that already reads back the same.
//
// #webmail is answered by an outside agent, not by a Forge session, so no binding names it until this
// script binds it: a group no binding of the project names is added to the `outsideRids` of the
// project's one Rocket.Chat binding, switched on or off, and nothing else of that binding changes.
// Forge keeps the group's record and answers nothing there. A project with no Rocket.Chat binding
// takes one on `--connection`, naming only that group.
//
//   FORGE_URL=https://forge-dev-api.sidcorp.co FORGE_TOKEN=<a PAT holding project.admin on sidcorp-mail> \
//     node scripts/seed-webmail-channel.mjs [--project <sidcorp-mail project uuid>] \
//       [--connection <a Rocket.Chat connection uuid, where the project has no binding>] [--dry-run]
//
// Members are keyed by Rocket.Chat username: the record keeps no email (BC-40), so the owner's seed
// by address is written as the username each address names.

const RID = '6ae2c51c6562facf823fa703';
const SLUG = 'sidcorp-mail';

export const MEMBERS = [
  {
    username: 'tramnnh',
    roles: ['user'],
    askFor: 'what she sees in webmail, and her own password',
  },
  {
    username: 'thanhnh',
    roles: ['technical', 'product'],
    askFor: 'node changes, deploys and DNS decisions; how webmail should behave',
  },
  {
    username: 'chuongld',
    roles: ['technical', 'maintenance'],
    askFor: 'what thanhnh cannot decide: access, credentials and the mail nodes',
  },
  { username: 'jarvis', roles: ['bot'], askFor: 'DNS changes, through the domain manager' },
];

export const RULES = [
  'Answer in the language the person wrote in, short and concrete.',
  'Answer mail users in plain Vietnamese about what they see and what to do in webmail: no commands, host names, issue keys or internals.',
  'Never ask a mail user to approve, run or decide anything technical.',
  'Reply when a message asks something, asks for work, reports a mail problem you can check, or answers your question. Stay silent on chatter, thanks and talk between people.',
  'A message addressed to someone else and not to you gets no reply.',
  'One message per request: the result, or the one question you need answered, in at most three short lines. Never post twice in a row in a thread.',
  'When a user reports a problem that needs a technical decision, answer the user plainly, then ask thanhnh separately in one short message naming the decision needed.',
  'Read-only checks on the mail nodes need no confirmation. Anything that changes a node runs only after chuongld or thanhnh confirms in the same thread.',
  'Deploys, Forge records, merge requests and issue keys are not news for the channel: say only what changed for its people, once it is live.',
  'When in doubt, stay silent.',
];

function arg(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const BINDING_SCHEMA = 'https://forge.sidcorp.co/schemas/binding-v1.json';

async function call(base, token, method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`${method} ${path} answered ${res.status}: ${text.slice(0, 600)}`);
  }
  return json;
}

async function projectId(base, token, named) {
  if (named) return named;
  const list = await call(base, token, 'GET', '/projects?limit=200');
  const rows = Array.isArray(list) ? list : (list.items ?? list.projects ?? []);
  const row = rows.find((p) => p.slug === SLUG);
  if (!row) throw new Error(`no project ${SLUG} reads back for this token; pass --project <uuid>`);
  return row.id;
}

/** The channel's record, or null when no binding of the project names the group. */
async function channelOf(base, token, path) {
  try {
    return (await call(base, token, 'GET', path)).channel;
  } catch (err) {
    const unknown = /answered 404/.test(err?.message) && /SUPPORT_CHANNEL_UNKNOWN/.test(err.message);
    if (unknown) return null;
    throw err;
  }
}

/** The project's one Rocket.Chat binding, as its document reads, or null. */
async function chatBinding(base, token, project) {
  const { bindings } = await call(base, token, 'GET', `/projects/${project}/bindings`);
  return bindings.find((b) => b.document?.target?.provider === 'rocketchat') ?? null;
}

/**
 * Name the group in the project's Rocket.Chat binding as answered by an outside agent, or bind one
 * on `connection` naming only it. Answers what was done, in words; writes nothing when `dry`.
 */
async function bindOutside({ base, token, project, rid, connection, dry }) {
  const held = await chatBinding(base, token, project);
  if (held) {
    const { document } = held;
    const outsideRids = [...(document.target.outsideRids ?? []), rid];
    if (!dry) {
      await call(base, token, 'PUT', `/projects/${project}/bindings/${document.id}`, {
        baseRevision: held.revision,
        document: { ...document, target: { ...document.target, outsideRids } },
      });
    }
    return `${dry ? 'would bind' : 'bound'} #${rid} in binding ${document.id}, answered by an outside agent`;
  }
  if (!connection) {
    throw new Error(
      `project ${project} has no Rocket.Chat binding to name the group ${rid} in; pass --connection <the project's Rocket.Chat connection uuid> to bind it, answered by an outside agent`,
    );
  }
  const id = crypto.randomUUID();
  if (!dry) {
    await call(base, token, 'PUT', `/projects/${project}/bindings/${id}`, {
      baseRevision: null,
      document: {
        $schema: BINDING_SCHEMA,
        version: 1,
        id,
        role: 'service',
        connection,
        active: true,
        target: { provider: 'rocketchat', outsideRids: [rid] },
      },
    });
  }
  return `${dry ? 'would bind' : 'bound'} #${rid} on connection ${connection}, answered by an outside agent`;
}

const EMPTY = { name: null, memberRows: [], ruleRows: [] };

/**
 * Seed one channel's record; `rid` is #webmail's unless a test names another group. A group no
 * binding names is bound first, answered by an outside agent.
 */
export async function seed({
  base,
  token,
  project,
  rid = RID,
  connection,
  dry = false,
  log = console.log,
}) {
  const pid = await projectId(base, token, project);
  const path = `/projects/${pid}/support/channels/${rid}`;
  let channel = await channelOf(base, token, path);
  if (!channel) {
    log(await bindOutside({ base, token, project: pid, rid, connection, dry }));
    channel = dry ? EMPTY : (await call(base, token, 'GET', path)).channel;
  }
  for (const m of MEMBERS) {
    const now = channel.memberRows.find((r) => r.username === m.username);
    const same =
      now?.state === 'confirmed' && now.askFor === m.askFor && now.roles.join() === m.roles.join();
    log(
      `${same ? 'kept' : dry ? 'would confirm' : 'confirmed'} @${m.username}: ${m.roles.join(' + ')}`,
    );
    if (!same && !dry) {
      await call(base, token, 'PUT', `${path}/members/${m.username}`, {
        roles: m.roles,
        askFor: m.askFor,
      });
    }
  }
  const held = new Set(channel.ruleRows.map((r) => r.text));
  for (const text of RULES) {
    const there = held.has(text);
    log(`${there ? 'kept' : dry ? 'would add' : 'added'} rule: ${text}`);
    if (!there && !dry) await call(base, token, 'POST', `${path}/rules`, { text });
  }
  const after = dry && channel === EMPTY ? EMPTY : (await call(base, token, 'GET', path)).channel;
  log(
    `#${after.name ?? rid}: ${after.memberRows.length} members (${after.memberRows.filter((m) => m.state === 'confirmed').length} confirmed), ${after.ruleRows.length} rules`,
  );
  return after;
}

async function main() {
  const token = process.env.FORGE_TOKEN;
  if (!token) throw new Error('FORGE_TOKEN is unset: a PAT holding project.admin on sidcorp-mail');
  await seed({
    base: (process.env.FORGE_URL ?? 'https://forge-dev-api.sidcorp.co').replace(/\/$/, ''),
    token,
    project: arg('--project'),
    connection: arg('--connection'),
    dry: process.argv.includes('--dry-run'),
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
