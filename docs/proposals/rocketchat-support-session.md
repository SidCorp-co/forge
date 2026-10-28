# A project's Rocket.Chat group answered by a Claude session Forge manages

**Removed when:** REQ-75 r5's criteria (BC-2, BC-10..BC-29) each hold a counting verdict. After that,
what holds is the code: `packages/contracts/src/support.ts`, `packages/contracts/src/support-operations.ts`,
`packages/core/src/support/` and `packages/core/src/integrations/support-api/`.

Requirement REQ-75 r2. The owner, 2026-10-26: "gắn thẳng vào group chat để hỗ trợ người dùng trực
tiếp và liên tục", and the shape: a user writes in the group, a Claude session Forge manages handles
every support task and answers at once, and what needs code becomes Feedback for Forge to process.

## What stood before this change, and why no dev project used it

`integrations/rocketchat/` (ISS-604) is live code, not dead code: a DDP bot connection with one
owner per connection (`connection-manager.ts`), room routing from bindings (`room-routing.ts`), the
outbound door that screens and scrubs (`outbound.ts`), thread registry for parked questions. It
feeds the team assistant (`assistant/chat-room/`), which answers **Forge people**: every turn acts
as the speaker's own Forge account (ISS-17), and a speaker linked to no Forge account is refused
(`assistant/window-decision.ts:decide` → `refuseAuthority`). A product's end users are never Forge
accounts, so in a customer group every message would be refused. That, plus nobody binding a room,
is why dev holds 0 rocketchat connections. Nothing in it is deleted by this change: the team
assistant keeps the rooms bound without `support`; a binding that carries `support` is routed to
the support session instead (`room-routing.ts:Route.support`).

## Decisions

### The handler is a resident chat session, not a second session host

One `agent_sessions` row of kind `chat` per bound group (BC-10), declared when the binding is read
(`support/rooms.ts:ensureSupportRoom`) and owned by the room's own agent account. Each message is
handed to it with the existing chat-turn path (`agent-sessions/chat-turn.ts:dispatchChatTurn`). The
session is warm before anyone writes (`support/warm.ts`): a warm-up turn that answers nothing spawns
and briefs Claude Code when the binding is saved (`integration.changed`), when a box of the project
comes online (`device.pushed`, status `online`), and from the `support.room-warm` sweep (every 30 s)
for a room whose session is not resident, so a member's first message is written into a running
process, not a cold start. A grant change re-tells a warm session the tools it may use (the brief is
read once), at once or after the turn that is running. Later turns go as `agent:send` with the stored
`claudeSessionId`, which the box writes into the resident process or resumes with `--resume` after a
restart (BC-16). A box change re-primes the session with every open thread's recent messages from
the conversation store (`support/prompt.ts:coldThreads`).

Not the master pane: a master is a tmux pane in `bypassPermissions` that the box itself declares and
keeps (`runner-daemon/src/master/`). A support session reads text written by strangers; the chat
host runs it confined (`agent-sessions/chat-door.ts:isChatDoorSession`, ADR 0012), holding only the
token core hands it, so a prompt injected by a group member reaches nothing the room was not
granted. The chat host also already lives in the sessions view and resumes by Claude's own session
id, which is what BC-16 asks.

**The resident stays.** Every support turn carries a fresh token fenced to the project, and the box
closed a resident whose turn carried its own token (`runner-agent/src/chat.rs:resident_disposition`),
because its MCP config held the spawning turn's token, revoked when that turn ended (migration
0324). So every support turn respawned Claude Code. A turn frame with `keepResident` (set for a
`supportRoom` session, `chat-turn.ts`) now spawns Claude Code with an MCP config that reads its bearer
from a file through `headersHelper` (`runner-workspace/src/mcp/config/mod.rs:write_refreshable`); each
turn writes its token there before it is written to the process, and Claude Code re-runs the helper
on a 401 and retries, so one process serves every turn without holding a revoked token. The file is
bound read-only into the confined session and no token is in its environment. Core's idle-residency
close (`jobs/park-deadline.ts:closeIdleResidents`) skips a `supportRoom` session: it stays resident
for as long as the room is bound.

A message goes to the session the moment it is recorded (`support/inbound.ts` →
`support/dispatch.ts:deliverWaiting`): as a turn of its own when none runs, or, while one runs,
written into that turn through the session inbox (RFC 0003, `support/inject.ts:injectWaiting`,
`session.send` kind `inject`), which the box writes into the resident's stdin as a stream-json user
message. What Claude Code 2.1.310 does with it, measured on this box: written while a tool call is in
flight, it is taken after the tool result and answered in the same turn (one `result`); written while
the model writes its last text, the turn ends and the message is answered as a second turn straight
after. The box ends the turn only when every message it wrote has been replayed back
(`claude_code/stream.rs`), and reports each write applied. A box with no turn in flight refuses the
write; core hands the messages back at once — on the refusal itself once core reads the turn ended
(read again every 250 ms for 2 s while it still reads it running), or at that turn's end
(`inject.ts:onInjectRefused`, `dispatch.ts:onSupportTurnEnded`). A write that reaches the box after core handed it a
turn, and before the box has written that turn into a process, waits for it and goes into that
turn's process (`claude_code/mod.rs:TurnPlacing`, held from the frame's arrival): core wrote it for
the turn it had just started, and the resident that turn may close is never fed. A resident the turn
cannot reuse (a model change, or a turn whose token it cannot read) is closed and reaped before the
replacement spawns under the same key, and killed if it has not ended 10 s after its stdin closed
(`claude_code/mod.rs:retire`); the replacement resumes the same Claude session, which no two
processes write at once. A session's end-of-turn bridges
fire after the write that ended it commits (`agent-sessions/session-transition.ts`); fired inside it,
the support bridge read the session still running, and a turn it handed over was refused and the
room backed off 30 s. The 2 s `support.room-drain` timer only
recovers what a crash left: a write nobody answered, or a message no turn took. A turn that cannot
reach a box gives its messages back and the room waits 30 s before the next try; a project with no
capable box is told so in the thread at most every 10 minutes (`support/dispatch.ts:deliverWaiting`).
A turn that ends failed or cancelled instead of completed tells each thread it left with no session
action that it went unanswered, once, and records a `refused` action (`turn_failed`) naming the
messages (`support/dispatch.ts:onSupportTurnEnded`). Those messages stay delivered: a box that fails
every turn is never handed them again, and the asker is told to send it again.

### Identity: a Rocket.Chat account is a visitor, and the server says who wrote a message

A group member is never a Forge user. The room's session acts as the room's own agent account
(`support_rooms.principal_user_id`), a member of nothing, as the widget's principal is
(`widget/principal.ts`). Its turn token is minted for that account, fenced to the project and named
`turn:<sessionId>`; every support route and the `forge_support` tool accept a caller only when it is
that account holding that session's token (`support/access.ts:sessionCaller`). The account holds no
role, so every other route refuses it.

Who asked is read from the DDP frame Rocket.Chat signed (`u._id`), never from text. The asker of a
fix is the account that wrote in that thread; the session names it, and core checks the account
wrote there (`SUPPORT_ASKER_NOT_IN_THREAD`).

### Tools: the project grants them, core runs them

A `support-api` integration connection holds the project's API base URL, the extra hosts it grants
and the scoped credential (headers, sealed in the vault); its binding declares the tools — each a
method, a path template and its parameters, `diagnose` (GET or HEAD only) or `fix`. That
declaration is policy (`VISION: kernel-hard-policy-soft`). The kernel is the caller
(`integrations/support-api/call.ts:callGranted`): a host outside the grant, a redirect, an
undeclared tool, a diagnose tool with a writing method or an argument not declared is refused by
name, and the credential is never in the session's hands, its prompt or any answer — responses and
every posted line pass the scrubber with the credential's values named (BC-17).

### Confirm: the asker's own message, with a button that writes it

Rocket.Chat's interactive blocks route a click only to an Apps-Engine app; a bot connected over
REST and DDP receives nothing (forum: *How to call an action through a button sent on a sendMessage
API block?*). Legacy attachment buttons with `msg_in_chat_window` post the button's text as the
person who pressed it (forum: *Hide messages from attached buttons in chats*). So the confirm is a
message `confirm <CODE>` from the asker, and the prompt carries a button that writes exactly that.
Either way the only thing that counts is a message the server attributes to the asker's account,
naming a pending fix's code — the chat-proposals principle (`contracts/src/chat-proposals.ts`).
Anyone else's `confirm` is answered "only @asker can confirm this" and runs nothing; a fix not
confirmed in 15 minutes expires. Slack bots built on Bolt do the same thing with their own buttons
(the click carries the clicking user's id, and the app compares it with the requester).

### What needs code is Feedback, linked to the thread, followed to shipped

Nothing is filed until its asker agrees (REQ-30 BC-4, the owner's confirm-before-recording rule):
the session's `record` restates the route (defect, feature or request), the title and the thread's
link in the thread, with the same `confirm <code>` / `cancel <code>` buttons a fix has, and waits in
`support_proposals` as kind `filing` with no tool, beside the fixes (kind `fix`, their tool named) in
one code space per room (`support/propose.ts:proposeRecord`; migration 0539 renamed `support_fixes`
and ended the reserved `forge:record` tool name it used to hide under). Only the asker's confirm files it; another member's, a
cancel or 15 minutes unconfirmed file nothing, and the session is told the key once it is filed.
Then core records a defect, a feature or an extra request as Feedback through the external
filing door (`feedback/external.ts:fileExternalFeedback`, channel `rocketchat`), as the room's
account, with the thread's permalink in the body and the thread told its key. A group member is
handed no status link — in a group anyone could open it, and the thread's own progress lines are the
status — so migration 0537 lets `feedback_external_reporters.status_token_hash` be null and checks
it is held by exactly the widget rows (`feedback_external_reporters_status_link_chk`). Minting a token
and discarding it would have stored a link nobody holds, and pulled the support module into the
credential walk (`middleware/credential-doors.test.ts`) as if it checked a secret.
Triage then routes it — to an issue, or promoted to a Requirement — as every item is; the session never files an issue (BC-14). The `support-progress` outbox consumer reads
each linked item's phase on `issue.created`, `issue.transitioned`, `release.shipped`,
`requirement.transitioned` and `feedback.verifySettled`, posts each change in the thread, and stops
at resolved, verified or declined (BC-15). A triage or a decline emits no event, so the
`support.progress-follow` timer reads every followed item again each minute
(`support/progress.ts:followAllItems`).

### The record

Every inbound message and every line the bot posts is a row of the thread's conversation (venue
`<server> <rid> <thread>`); every action — a check, a proposal, a confirm, a refusal, a filing, a
progress post — is a `support_actions` row and a `system` line in that conversation, so the Forge
conversation view shows it and `GET /api/projects/:id/support/rooms/:roomId/actions` lists it
(BC-18).

### Latency

Each message the session answers carries its latency on its `message_in` action: from the Rocket.Chat
server's own timestamp (`ts`, EJSON `{ $date }` on DDP) to the session's first post in its thread
(`support/delivery.ts:settleLatency`), with the path it took — `start` (a cold start), `send` (a turn
of its own on the resident) or `inject` (written into a running turn). The room read
(`GET /api/projects/:id/support/rooms`) shows `resident` and p50/p95 over the last 200, overall and by
path. Before this change the DDP parse dropped `ts` (it read a string, the server sends `{ $date }`),
so a message's server time was never recorded.

Measured 2026-10-26 on Rocket.Chat 6.13.1 in Docker, core as in the e2e, and a box driving a real
resident `claude` 2.1.310 through the gateway with the runner's turn rules (bearer by
`headersHelper`, stdin injection, replay counting), ms from the server's stamp to the first reply:

| Path | Samples (ms) |
|---|---|
| Cold first message, no warm-up (`start`) | 20 357, 12 585 |
| First message after the warm-up (`send`) | 9 671 |
| Warm message (`send`) | 16 578, 11 855, 8 972, 7 233, 12 708, 7 517 |
| Mid-turn message, written 1.5 s into a turn that checks the order API (`inject`) | 13 235, 4 861, 9 824 |
| First message after the box lost its process (`--resume`) | 10 322, 7 200, 7 612 |

Core's part is under a second (the e2e holds the hand-over to it); the rest is the model's turn —
searching, reading the thread, replying — which varies more than the paths differ. The warm-up takes
the 2–8 s spawn and brief out of the first reply.

### How the session acts

One MCP tool, `forge_support` (`support/tool.ts`), with a REST twin per action under
`/api/projects/:id/support/session/*` (`support/routes.ts`); both call `support/acts.ts:supportAct`.
Actions: `search`, `thread`, `tools`, `reply`, `run`, `propose_fix`, `record`. People read
`GET /api/projects/:id/support/rooms` and `…/rooms/:roomId/actions` with `project.read`.

## Operations rooms (REQ-75 r4 BC-20..BC-24)

The same machinery answers a team's room under a bot's role. A `rocketchat` binding carrying
`operations { scope }` instead of `support` attaches any number of rooms (`rids`), and each is its
own `support_rooms` row (kind `operations`, its `scope`) with its own resident session on the box of
the binding's project, its home (`support/rooms.ts:declareSupportRooms`). `scope: forge` reaches
every project of the home project's organization; `scope: project` the home project alone
(`support/ops-scope.ts`). Two rooms of one bot reach what their own bindings say.

**A role is data on the bot's connection** (BC-22): `config.role { name, persona, grants }`, one per
Rocket.Chat account, since the connection is the account. The persona opens the session's brief in
the owner's words (`support/ops-prompt.ts`); a connection edit re-tells a resident session its role.
The grants are `read`, `deliver`, `draft` and `research`, and each `forge_support` operations act
needs one (`OPERATIONS_ACTION_GRANT`): `projects`, `issues`, `releases` read; `move` delivers;
`draft_requirement`, `draft_feedback` draft; `research` reads one public page. An act the role lacks
is refused naming the grant (`OPS_ROLE_NOT_GRANTED`, `support/ops-role.ts:grantRefusal`) before
anything is read, so Babo, granted `read` and `deliver`, never drafts product direction (BC-23), and
Sy, granted `read`, `draft` and `research`, never moves delivery (BC-24). No act decides product
direction at all: a draft waits for a person.

**A write runs as the member who asked, never as the bot** (BC-21). Core names the asker, not the
session: the member who wrote last in the thread, by the account id Rocket.Chat signed
(`support/ops-asker.ts`). That account is a Forge user through a confirmed speaker link
(`assistant_speaker_links`, the explicit map, which wins), or else when the address the chat server
holds for it is verified there and is a Forge account's verified address. The act then runs under
that user's own permissions — the `requireCan` and kernel guards their own click would meet — with
the turn's token recorded as the credential acting for them (`kernel_transitions.actor_token_id`,
`actor_on_behalf_of`; `support/ops-acts.ts:asAsker`). A member Forge cannot name may only read
(`OPS_ASKER_UNMAPPED`); a mapped member without the permission is refused naming it
(`PERMISSION_FORBIDDEN … project.write`). A project outside the scope is `OPS_OUT_OF_SCOPE`.

`research` is fetched by core, not by the confined session: https on 443 only, every address the
host resolves to public, the connection made to the address checked, no redirect followed, the page
cut to text (`support/ops-research.ts`). An operations room's replies are screened at the
`operations-reply` door (`role:chat`): its readers are the team the room was bound for. A support
group's acts (`search`, `tools`, `run`, `propose_fix`, `record`) are refused in an operations room
(`SUPPORT_NOT_A_SUPPORT_ROOM`) and the operations acts in a support group.

The proof is `packages/core/tests/integration/support-operations-e2e.test.ts`, two bot accounts on
one chat server (a stand-in, or a real Rocket.Chat with `OPS_E2E_RC=<file>`; the shape is in
`tests/helpers/ops-chat-server.ts`).

## Support groups set up, checked and granted from the binding (REQ-75 r5 BC-25..BC-29)

The hand-run watchers this replaces were a Claude Code pane per group, started by a script on one
box with a prompt file of its own (`forge-local-docs/babo/babo-setup.py`). r5 moves everything that
pane carried onto the binding, so the binding is the whole setup.

**The binding holds the room (BC-25).** Project settings → Integrations → Rocket.Chat → *Add a
support group* saves, in one write through the binding door, everything the room needs:
- the group;
- `support.product` and `support.persona`, the standing instructions a watcher's prompt file held;
- `readers`: `users` for a customer group, screened as `support-reply`; `team` for a group of the
  team's own people whose members are not mapped, screened as `operations-reply`;
- `answers`: `every-message`, or `mentions`, where every message is recorded as the thread's context
  and only one naming the bot is handed to the session;
- `grants`.

The `support-rooms` consumer declares the room and warms its session from that write alone
(`support/warm.ts`). Nothing is started on a box beyond the project's own runner. The same block is
writable as a binding document (`PUT /api/projects/:projectId/bindings/:bindingId`), which is how
the setup calls below and the tests drive it.

**A room says why it is not answering (BC-26).** `support/health.ts:roomHealth` reads each cause
separately and names what to do about it. It is shown in the rooms table and on
`GET /api/projects/:projectId/support/rooms`.

| Cause | Read from |
|---|---|
| `BINDING_OFF` | binding or connection inactive |
| `BOT_REJECTED` / `CHAT_UNREACHABLE` | the chat server's answer to `subscriptions.getOne` |
| `BOT_NOT_IN_ROOM` | `subscriptions.getOne` answers no subscription |
| `NOT_LISTENING` | no core holds the connection's advisory lock, or its socket is reconnecting (`connection-manager.ts:connectionListening`) |
| `NO_BOX` | no online box of the project can run the session |
| `BOX_TOO_OLD` | the box does not declare a capability the grant needs (`SUPPORT_BOX_CAPABILITIES`) |
| `SESSION_NOT_LISTENING` | no session yet, or not resident on its box |

This is how Mattermost reports a plugin and a channel member separately
(`server/public/model/plugin_status.go`; `server/channels/app/authorization.go:SessionHasPermissionToChannel`
returns the permission and the membership apart).

**Grants are named abilities (BC-27).** `support.grants` is `{ abilities, deployTargets?, hosts?,
confirmers? }` (`contracts/support.ts:supportGrantsSchema`). The abilities are:

| Ability | What the session may do | Waits for |
|---|---|---|
| `read_checkout` | read the project's checkout, mounted read-only (`checkout: "read"`) | — |
| `file_items` | `record` Feedback | the asker's confirm |
| `deliver` | `move_issue`, as the member who asked | — |
| `build` | edit a working copy of the development branch the box keeps for the room (`checkout: "build"`), then commit on `feat/`/`fix/`, push without force, and open a change request into the development branch | a confirmer |
| `deploy` | deploy a bound Coolify target the grant names | a confirmer, then a production target's own approver |
| `run_commands` | run a command over the box's SSH on a host the grant names | a confirmer, unless it only reads (`support/command-class.ts`) |

Further rules:
- A grant naming a reach without its ability, an ability without its reach, or a waiting ability
  without confirmers is refused at the binding door. So is a deploy target the project does not bind
  (`SUPPORT_GRANT_TARGET_UNKNOWN`).
- `build` never branches from or into a branch a production environment deploys from
  (`support/build.ts:buildBaseOf`). The release goes through Forge.
- A room with neither `read_checkout` nor `build` sees no checkout at all (`checkout: "none"`).
- Each confirmed change re-reads the grant at the confirm (`support/ability-run.ts:runConfirmed`).
  A change that throws on the way is settled `failed` and said in the thread.

**Refused by name (BC-28).** An ungranted act is refused with `SUPPORT_ABILITY_NOT_GRANTED`, before
anything runs (`support/grants.ts:abilityRefusal`). The refusal names:
- the ability and what it does;
- what the room holds;
- who can grant it — the project's admins by name, in Project settings → Integrations → Rocket.Chat.

Core posts it in the thread whether or not the session repeats it, and records it. A confirm from
anyone but a named confirmer is refused the same way. Prior art for the shape of the refusal:
- Slack's `missing_scope` answers `needed` and `provided`
  (`slackapi/node-slack-sdk packages/web-api/src/types/response/ChatPostMessageResponse.ts`);
- Rocket.Chat's Apps-Engine `PermissionDeniedError` names the permission the app lacks
  (`packages/apps/src/server/errors/PermissionDeniedError.ts`);
- GitHub answers `X-Accepted-GitHub-Permissions`.

**The box does the acts core has decided.** The box answers each on the device route under the
request's id (`runners/box-acts.ts`):
- `host.command`: `ssh -o BatchMode=yes -T -- <host> <command>` with the box's own keys, outside the
  session's sandbox, killed at 60 s, each stream capped at 32 KiB. It answers on
  `/api/devices/me/host-commands/:requestId`.
- `build.push`: commit and push the room's working copy. It answers on
  `/api/devices/me/support-builds/:requestId`.

A box declares `hostCommands`, `chatCheckoutModes` and `supportBuilds`, the last two only where it
can confine a session. A support turn on a box that cannot scope its checkout is refused
(`BOX_CANNOT_SCOPE_CHECKOUT`), never run with the whole checkout writable.

**Migration (BC-29).** Each hand-run watcher becomes a binding of its group, one room at a time:
1. Its prompt file's standing instructions become `persona`.
2. What it did becomes `grants`.
3. Its pane stops only after the bound room has answered a real mention.

The sid-email watcher stays until the coordinator has seen the bound room do `build`, `deploy` and
`run_commands` end to end in that group. The rooms' state is in the lane's report, not here: it
changes as each one moves.

## Honest costs

- **A box per project.** The session runs on a paired runner bound to the project with a checkout,
  declaring `turnCredential`, `confinedChatNetwork` and, for a support group, `chatCheckoutModes`
  (plus `supportBuilds` / `hostCommands` where the grant holds `build` / `run_commands`). No box, no answer: the group is told the
  assistant is offline and its messages wait.
- **Knowledge has no audience flag.** `search` reads every knowledge entry of the project and the
  checkout's docs. What keeps internal text out of a customer group is only the `support-reply`
  screen (cell `public:report`) and the brief. A project that keeps internal notes in knowledge
  should read what its group could be told before binding one.
- **BC-11's 30 s is the box's model, not core.** Core hands a message to the box in milliseconds
  (the e2e measures it); the answer time is Claude Code's turn on the box, which no test here can
  bound.
- **One resident Claude Code per bound group, for as long as it is bound.** A box holds one process
  per room whether anyone writes or not; the idle close that frees other chats does not apply.
- **Warm-ups are model calls.** Each bind, each box coming online, each grant change and each core
  restart's first grant change spends one short turn per room ("ready"), with no member waiting.
  Core keeps which tools it told each room in memory only: after a core restart the next grant
  change re-tells them even if nothing changed.
- **A box restart inside its heartbeat window is not seen as one.** Core still reads the session
  resident, the box comes back without its process, and the first message after it resumes cold
  (`--resume`, the last row above) instead of having been warmed; the `online` warm-up fires only
  when the box had been marked offline.
- **Every turn's first tool call pays one 401.** Claude Code opens with the bearer it read last,
  which the previous turn's end revoked; it re-runs `headersHelper` on the 401 and retries
  (measured: tens of ms).
- **The confirm is a typed message.** Legacy attachment buttons post `confirm <CODE>` as the person
  who pressed them; Rocket.Chat's UIKit buttons would need an Apps-Engine app, which this does not
  ship. A member who types the line by hand confirms just the same, and only the asker's account
  counts.
- **The asker is the thread's latest writer.** A command and a second member's line landing before
  the session acts runs the command as the second member: never with more than that member holds,
  but not as the one who asked. Ask in a thread of your own.
- **An operations room's readers are whoever the room admits.** The reply screen is the team's
  (`role:chat`), and an unmapped member in the room reads what the team reads; who is in the room is
  Rocket.Chat's to decide.
- **A move from chat sends no unblock toast.** The issue door's `issue.unblockCascade` broadcast is
  published by its route, which an operations move does not pass through; the dependents are still
  admissible at the next claim.
- **One rocketchat binding per project.** Each room with a scope of its own needs a home project of
  its own (`integration_bindings_service_uq`), and that project's box runs its session.
- **Two scrub layers, one source of truth.** Every line core posts is scrubbed with the bot token
  and each word of every credential header (`integrations/support-api/call.ts:credentialValuesOf`);
  a credential the product API returns under another shape (encoded, split) is not recognised.

- **A command's class is a list, not a parse.** `run_commands` runs a command at once only when every
  stage of its pipeline is a program known only to read, with no shell construct. Anything else waits
  for a confirmer, including a read the list does not know. A confirmer is the gate; the box's SSH
  key decides what any command can reach at all.
- **A build's working copy lives on one box.** It is kept under `<base_dir>/support-builds/<room>`
  on the box that ran the turn. If the next turn lands on another box of the project, the session
  starts from a fresh copy of the development branch.
- **`readers: team` trusts the group's membership.** A team group's replies are screened as the
  team's (`operations-reply`), and whoever Rocket.Chat admits to the group reads them.

## Setup (BC-19)

Per project, with a project admin's token. Each call is `forge-runner api`, with `FORGE_PAT` set and
`--core-url` naming the core (`https://forge-dev-api.sidcorp.co` on dev). A Rocket.Chat connection
holds the bot; one connection may carry the bindings of several projects, one group each.

1. The Rocket.Chat bot and its group, with the bot a member of the group:

   ```sh
   forge-runner api --core-url "$CORE" integration-connections --data '{
     "provider": "rocketchat", "displayName": "Support bot",
     "config": { "serverUrl": "https://chat.example.com" },
     "secrets": { "userId": "<bot user id>", "authToken": "<bot personal access token>" },
     "bindings": [{ "projectId": "<project uuid>", "role": "service",
       "target": { "provider": "rocketchat", "rids": ["<group rid>"],
                   "support": { "product": "<one or two sentences: what the product is>" } } }] }'
   ```

   A support binding names exactly one group (`SUPPORT_ROOM_NOT_ONE_GROUP` otherwise). Optional
   `support.limits`: `messagesPerUserPerHour` (30), `fixesPerUserPerDay` (10), `messageMaxChars`
   (4000), `responseMaxBytes` (16000).

2. The product API the session may check and fix through:

   ```sh
   forge-runner api --core-url "$CORE" integration-connections --data '{
     "provider": "support-api", "displayName": "<product> API",
     "config": { "baseUrl": "https://api.example.com/v1", "hosts": [] },
     "secrets": { "headers": { "Authorization": "Bearer <scoped support credential>" } },
     "bindings": [{ "projectId": "<project uuid>", "role": "service",
       "target": { "provider": "support-api", "tools": [
         { "name": "order_status", "kind": "diagnose", "method": "GET", "path": "/orders/{orderId}",
           "summary": "read order status",
           "params": { "orderId": { "in": "path", "description": "the order number", "pattern": "[0-9]{3,10}" } } },
         { "name": "resend_invoice", "kind": "fix", "method": "POST", "path": "/orders/{orderId}/invoice",
           "summary": "resend the invoice",
           "params": { "orderId": { "in": "path", "description": "the order number", "pattern": "[0-9]{3,10}" } } } ] } }] }'
   ```

   A `diagnose` tool is GET or HEAD only; a `fix` waits on the asker. Hosts other than the base
   URL's are named in `hosts`; nothing else is ever called, and a redirect is refused.

3. The box: on the runner that serves the project, `forge-runner bind <project slug> --path <checkout>`
   (the checkout is where the session reads the product's docs). The room and its session are
   declared when the binding is saved (`support-rooms` consumer); the session starts on the first
   message. Read it back: `forge-runner api --core-url "$CORE" projects/<uuid>/support/rooms`.

4. Check: write in the group. The bot reacts 👀 at once and answers in the thread. Every action is in
   `projects/<uuid>/support/rooms/<roomId>/actions`; the session is in the Agents view.

For Catalog and AdminHub the same three calls run once per bound project, with the inputs below.

### Operations rooms (BC-20..BC-24)

One connection per bot account, its role in `config.role`, and one binding per room scope:

```sh
forge-runner api --core-url "$CORE" integration-connections --data '{
  "provider": "rocketchat", "displayName": "Babo",
  "config": { "serverUrl": "https://chat.sidcorp.co",
    "role": { "name": "babo", "grants": ["read", "deliver"],
              "persona": "You are Babo. You coordinate Forge and delivery: projects, masters, runners and releases, and you support the project groups. You never decide product direction." } },
  "secrets": { "userId": "<babo user id>", "authToken": "<babo personal access token>" },
  "bindings": [{ "projectId": "<home project uuid>", "role": "service",
    "target": { "provider": "rocketchat", "rids": ["<Forge-Communicate rid>"],
                "operations": { "scope": "forge" } } }] }'
```

Sy is the same call with its own account, `"grants": ["read", "draft", "research"]`, a persona that
works on product direction, requirements, feedback and research as drafts a person decides and never
moves delivery, and its room bound from another project of the organization (one rocketchat binding
per project). A project group Babo supports is a binding of that project with
`"operations": { "scope": "project" }`.

The live bindings, made by the coordinator on chat.sidcorp.co:

| Room | Bot (account) | Role | Scope |
|---|---|---|---|
| Forge-Communicate | Babo (`chuong_bot`, username `babo`) | `read`, `deliver` | forge |
| AgentSocialTeams | Sy (`digital`) | `read`, `draft`, `research` | forge |

Each person who acts in them is a Forge user by a verified address both sides share, or by a
confirmed speaker link; the bots need `view-full-other-user-info` to read a member's address.

### What the owner gives

- The Rocket.Chat server URL, and a bot account (user id and a personal access token) that is a
  member of each support group.
- Per group: its rid, and which Forge project it binds to (Catalog: `catalog-api` or `catalog-fe`;
  AdminHub: `adminhub-api` or `adminhub-fe`), and one or two sentences on what the product is.
- Per product: the API base URL, a credential scoped to what support may do, and the list of checks
  and fixes it grants (name, method, path, parameters).
- The runner and checkout that serve each project.

## Dev acceptance (BC-10..BC-18 before any real group)

The owner's ruling: prove it on dev first. Nothing here is deployed by the lane.

1. **Rocket.Chat test instance**, on any Docker host the dev runner can reach:

   ```sh
   docker network create rc-dev-net
   docker run -d --name rc-dev-mongo --network rc-dev-net mongo:6.0.19 --replSet rs0 --oplogSize 128
   docker exec rc-dev-mongo mongosh --quiet --eval 'rs.initiate({_id:"rs0",members:[{_id:0,host:"rc-dev-mongo:27017"}]})'
   docker run -d --name rc-dev --network rc-dev-net -p 3999:3000 \
     -e ROOT_URL=https://<rc host> -e PORT=3000 \
     -e MONGO_URL='mongodb://rc-dev-mongo:27017/rocketchat?replicaSet=rs0' \
     -e MONGO_OPLOG_URL='mongodb://rc-dev-mongo:27017/local?replicaSet=rs0' \
     -e OVERWRITE_SETTING_Show_Setup_Wizard=completed \
     -e ADMIN_USERNAME=rcadmin -e ADMIN_PASS=<admin password> -e ADMIN_EMAIL=<admin email> \
     rocketchat/rocket.chat:6.13.1
   ```

   The dev core must reach it over HTTP(S) and WebSocket (`/websocket`).

2. **Accounts and groups**, as the admin (`POST /api/v1/login`, then with its `X-User-Id` and
   `X-Auth-Token`): turn off two-factor for the test users (`Accounts_TwoFactorAuthentication_Enabled`
   false), create the bot `supportbot` with role `bot` (`users.create`), create a personal access
   token for it (`users.generatePersonalAccessToken` as the bot), create two test members, and one
   private group per test project (`groups.create` with the bot and the members), e.g.
   `catalog-support-test` and `adminhub-support-test`. Each group's `_id` is its rid.

3. **Bind on dev core** with the setup calls above, `CORE=https://forge-dev-api.sidcorp.co`, one
   Rocket.Chat connection carrying both bindings (one group per test project), and a `support-api`
   connection per test project pointing at the product's dev API with a dev-only credential.

4. **The session on the dev runner**: the dev runner bound to each test project with its checkout
   (`forge-runner bind <slug> --path <dir>`), online, at a version that declares `turnCredential`
   and `confinedChatNetwork`, built with this change (an older box ignores `keepResident` and
   respawns Claude Code every turn). Nothing else is started: binding the group
   warms its session there, and it shows in the dev Agents view.

5. **Judge BC-10..BC-18** in the groups, reading `support/rooms/<roomId>/actions` and the Feedback
   list. The local proof the same flows hold is `packages/core/tests/integration/support-room-e2e.test.ts`,
   run against a real Rocket.Chat with `SUPPORT_E2E_RC=<file>` naming
   `{ url, rid, bot: { userId, authToken }, members: { alice: {…}, bob: {…} } }`.
