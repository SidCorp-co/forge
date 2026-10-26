# A project's Rocket.Chat group answered by a Claude session Forge manages

**Removed when:** REQ-75 r2's criteria (BC-2, BC-10..BC-19) each hold a counting verdict. After that,
what holds is the code: `packages/contracts/src/support.ts`, `packages/core/src/support/` and
`packages/core/src/integrations/support-api/`.

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
handed to it with the existing chat-turn path (`agent-sessions/chat-turn.ts:dispatchChatTurn`): the
first turn cold-starts Claude Code on a paired box of the project; later turns go as `agent:send`
with the stored `claudeSessionId`, which the box writes into the resident process or resumes with
`--resume` after a restart or an idle close (BC-16). A box change re-primes the session with every
open thread's recent messages from the conversation store (`support/prompt.ts:coldBrief`).

Not the master pane: a master is a tmux pane in `bypassPermissions` that the box itself declares and
keeps (`runner-daemon/src/master/`). A support session reads text written by strangers; the chat
host runs it confined (`agent-sessions/chat-door.ts:isChatDoorSession`, ADR 0012), holding only the
token core hands it, so a prompt injected by a group member reaches nothing the room was not
granted. The chat host also already lives in the sessions view and resumes by Claude's own session
id, which is what BC-16 asks; the runner needs no change.

A message that arrives while a turn runs waits as an undelivered `message_in` action and goes in the
next turn, which the session's own end starts (`terminal-effects.ts` marker `supportRoom`), a
confirm's answer starts (`support/inbound.ts:handleSupportMessage`), or the `support.room-drain`
timer (every 2 s, `timer-registry.ts`) does for a room whose turn end was missed. A turn that cannot
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

The session records a defect, a feature or an extra request as Feedback through the external
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

### How the session acts

One MCP tool, `forge_support` (`support/tool.ts`), with a REST twin per action under
`/api/projects/:id/support/session/*` (`support/routes.ts`); both call `support/acts.ts:supportAct`.
Actions: `search`, `thread`, `tools`, `reply`, `run`, `propose_fix`, `record`. People read
`GET /api/projects/:id/support/rooms` and `…/rooms/:roomId/actions` with `project.read`.

## Honest costs

- **A box per project.** The session runs on a paired runner bound to the project with a checkout,
  declaring `turnCredential` and `confinedChatNetwork`. No box, no answer: the group is told the
  assistant is offline and its messages wait.
- **Knowledge has no audience flag.** `search` reads every knowledge entry of the project and the
  checkout's docs. What keeps internal text out of a customer group is only the `support-reply`
  screen (cell `public:report`) and the brief. A project that keeps internal notes in knowledge
  should read what its group could be told before binding one.
- **BC-11's 30 s is the box's model, not core.** Core hands a message to the box in milliseconds
  (the e2e measures it); the answer time is Claude Code's turn on the box, which no test here can
  bound.
- **The confirm is a typed message.** Legacy attachment buttons post `confirm <CODE>` as the person
  who pressed them; Rocket.Chat's UIKit buttons would need an Apps-Engine app, which this does not
  ship. A member who types the line by hand confirms just the same, and only the asker's account
  counts.
- **Two scrub layers, one source of truth.** Every line core posts is scrubbed with the bot token
  and each word of every credential header (`integrations/support-api/call.ts:credentialValuesOf`);
  a credential the product API returns under another shape (encoded, split) is not recognised.

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
   and `confinedChatNetwork`. Nothing else is started: the first message in a group cold-starts its
   session there, and it shows in the dev Agents view.

5. **Judge BC-10..BC-18** in the groups, reading `support/rooms/<roomId>/actions` and the Feedback
   list. The local proof the same flows hold is `packages/core/tests/integration/support-room-e2e.test.ts`,
   run against a real Rocket.Chat with `SUPPORT_E2E_RC=<file>` naming
   `{ url, rid, bot: { userId, authToken }, members: { alice: {…}, bob: {…} } }`.
