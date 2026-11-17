# 0015 — A Forge Box is a kernel record the runner runs

**Status:** accepted · **Date:** 2026-11-17 · **Issue:** ISS-1276 · **Supersedes:** none; applies
ADR 0009 to UI test boxes

## Context

Agents test UI with nothing Forge can show. A judge records a clip by hand (`pnpm --filter web-v2
clip`), and a person cannot watch an agent's session, take it over or hand it back. The owner asked on
2026-11-17 for a "Forge Box": a screen agents test in, which he can open in Forge, watch live, take
and hand back. He also asked that boxes scale with the work and the machine's health, with no fixed
ceiling. Requests wait at the limit. iOS is out of scope for now.

These were measured on sid-xeon-1 that day:

- **agent-browser 0.43** streams JPEG frames over a loopback WebSocket, only when the screen changes.
  It refuses a browser Origin, and accepts a server-side client.
- **Agent and person input interleave with no lock.** The agent's commands ran at 13–158 ms while a
  person clicked, so no tool holds the lock. Forge has to.
- **An Android emulator** boots off a shared base AVD and snapshot in about 12 s with `-read-only`
  and costs 3.7 GB each. 3–4 cores while driven.

Forge already has three parts the box can reuse:

- **the preview tunnel**: `packages/runner/crates/runner-preview/src/tunnel.rs`, dialled to
  `/ws/preview-tunnel`, which copies bytes without reading them;
- **the run-slot rule**: `packages/core/src/devices/run-slots.ts:slotsFor`;
- **the verdict clip flow**: `packages/core/src/issues/criteria/clip-citation.ts:clipFault`.

## Decision

**A box is a kernel record in core, and the runner only runs it** (ADR 0009). The contracts are
`packages/contracts/src/boxes.ts` (the record, its machine, its refusals and doors) and
`packages/contracts/src/box-wire.ts` (what crosses to the runner and to a viewer).

- **The record:**
  - **Fields:** mode (`browser`, `android`, `desktop`), project, issue, criterion, holder (`agent:<run>`
    or `person:<user>`), state and recording.
  - **States:** `waiting`, `opening`, `warm`, `agent`, `person`, `closed`, `failed`.
  - **Moves:** open, close, take, release and expire, each written by the one kernel transition, so
    `kernel_transitions` records who made it and when.
  - **Who holds it** is the state itself: `agent` or `person`. Take, release and an idle expiry are
    edges, never a side field.
- **Refusals, by name:**
  - **`BOX_HELD_BY_PERSON`**: a person holds the box. It names who, and since when.
  - **`BOX_MODE_UNAVAILABLE`**: the box lacks the mode. It names what is missing and the fix. `ios` is
    refused by this name too.
  - **`BOX_SLOT_UNAVAILABLE`**: the request waits. It names its queue position and the health reason.
- **Core decides, the runner obeys:**
  - who holds a box;
  - whether an act is a read or a write: `BOX_READ_VERBS`, which fails closed, so an unlisted verb is
    a write;
  - who may view;
  - when a waiting request starts;
  - which span of a recording becomes a criterion's clip.
- **The runner reports facts:**
  - headroom: available memory against its reserve, CPU PSI against its ceiling, disk, KVM;
  - each mode it can serve, with what that mode costs;
  - the boxes it holds;
  - what an act printed;
  - the recording offset a mark landed at.

  The reserves and the ceiling are the device's own resource limits, from its `[box]` config, as
  `max_job_panes` is.
- **Allocation is the run-slot rule, extended.** Box demand rides `slotsFor`. There is no second
  counter and no fixed maximum:
  - a project with box demand gets its first box before any project gets a second;
  - the rest go round-robin, urgent first;
  - a box starts only while its mode's cost fits what the latest measurement leaves after the
    reserve, less the cost of boxes started since that measurement;
  - a request that does not fit waits on the record, with its position and reason, and starts when a
    later heartbeat leaves room;
  - each served mode keeps one warm box, the last thing allocated.
- **The live view travels the preview tunnel.**
  - **Streams:** one per viewer socket, opened by core with `{boxId, channel, fps}`. The runner
    copies it to the box's loopback endpoint for that channel.
  - **No new port and no tailnet.**
  - **Watch-only by default:** a viewer gets the `view` channel. Only the holder gets an `input`
    channel, of Forge's own `BoxInput` lines, which core records and the runner translates for the
    mode.
  - **Agent-browser's socket also takes input,** so for a browser box core is the WebSocket client.
    It forwards only frames to a viewer, at that viewer's rate.
- **Recording becomes evidence.**
  - Every box records its whole session.
  - The agent marks a criterion's span. Core orders the clip and its opening still cut from it, within
    the release page's ceiling, and attaches both to the issue under the criterion. A verdict cites
    them as it cites a hand-made clip today.
  - When the issue ends, core has the device drop the recording.

## Consequences

- **The cut runs on the device, at core's order.** The recording stays on the machine that holds
  ffmpeg (installed there for the boxes), and only the clip and still cross the network. Core holds
  no ffmpeg and never downloads a whole session. Core still chooses the span's bounds and the ceiling,
  and refuses a clip over the ceiling.
- **An agent's every act goes through core**, one HTTP round trip and one control frame. That is the
  price of a lock no tool has. Reads stay cheap, since they never wait on a hold.
- **iOS is a mode the contract names and refuses.** A device that can serve it later (a remote Mac, a
  device cloud) reports it under the same health contract, and nothing else changes.
- **The tunnel's open frame now carries two target shapes,** so the runner's codec mirrors both. The
  shared fixtures `packages/contracts/fixtures/preview-tunnel-frames.json` hold both codecs to them.
