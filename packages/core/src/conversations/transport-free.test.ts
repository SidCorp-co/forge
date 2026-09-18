import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = fileURLToPath(new URL('.', import.meta.url));

// cm:guard there is no exception list and there must not become one: the Forge UI's own adapter surface lives in `assistant/conversation-routes.ts` precisely so nothing here needs carving out.
const TRANSPORT_WORDS = [
  'rocketchat',
  'RocketChat',
  'telegram',
  'Telegram',
  'widget',
  'slack',
  'Slack',
  'discord',
  'ddp',
];

function storeFiles(): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
}

/**
 * What an adapter may import from here: the contract it implements, and the neutral machinery it is
 * a CALLER of.
 */
// cm:guard `inbound-turn.js` left this list because the module left the tree: ISS-1004 split the turn-per-message into a collect and a later route, and `collect-inbound.js` + `route-window.js` + `windows.js` are what an adapter now calls in its place. What has NOT widened is the rule — no store function is on this list, and `store.js` appearing here would mean an adapter reading rows directly again, which is the coupling this file exists to fail CI on.
// cm:guard `transcript-search-tool.js` is on this list for the reason the list exists rather than as an exception: it is neutral machinery an adapter is a CALLER of, not a store function re-exported. It names no transport, holds no adapter's knowledge, and takes what is transport-specific — the permalink a message id resolves to, and what this venue does not cover — as arguments the caller supplies. It reaches the store through `transcript-search.js`, which is not on this list and which an adapter therefore still cannot import (ISS-1090).
const ADAPTER_FACING = [
  'ports.js',
  'turn-runner.js',
  'transcript.js',
  'transcript-search-tool.js',
  'collect-inbound.js',
  'route-window.js',
  'windows.js',
];

/**
 * Who may reach the store from outside this directory, whole-tree and frozen.
 */
// cm:guard `assistant/conversation-adapter.ts` is the fifth name and the argument for it is the one this comment demands: it is the Forge UI's OWN four ports, which is what the header above says this list exists to accommodate without an exception, and the two functions it needs are `findConversation` — to place the venue its `deliver` was handed — and `listParticipants` — to know whose sockets that delivery goes to. Neither is reachable through the adapter-facing set, because no adapter before this one delivered to people rather than to a server (ISS-1004 step 5).
// cm:guard the integrations scan below catches a DIRECT import; this catches the way around it, which is a module outside integrations re-exporting or wrapping the store for an adapter to import instead — that intermediary has to appear here as a new name and be argued for. What neither catches is a wrapper somebody writes inside an already-listed file, and that is the honest limit of this gate rather than a gap to paper over (ISS-1002 review, F2).
// cm:guard `assistant/conversation-access.ts` and `assistant/conversation-member-routes.ts` are the sixth and seventh names, and the argument is the one this list already accepted for the routes file beside them: both are the Forge UI's own surface rather than a transport's, and neither is reachable through the adapter-facing set. The access module exists BECAUSE the routes file grew a second router — it holds the three door checks so one copy serves both, which is strictly fewer store readers than two routers each keeping their own; the member routes reach `participants.js` because changing who is in a room is what they are for (ISS-1011).
// cm:guard `assistant/conversation-send.ts` is the eighth name, and the argument is the one this list
// already accepted for the routes file and the adapter beside it: it is the Forge UI's own send path
// rather than a transport's. What it reaches for is `settleConversationMode` — which has to run
// INSIDE the transaction the collector commits the first message in, so mode-and-no-message and
// message-and-no-mode are both unreachable — plus the read-back that says which mode won a race.
// Neither is reachable through the adapter-facing set, because no adapter before this one had a
// property of the room that its own first message settles (ISS-1039).
// cm:guard `assistant/conversation-agent-offer.ts` is the ninth name, and the argument is the sixth
// name's exactly: `conversation-routes.ts` reached its 500-line budget, and what came out of it is
// one question the Forge UI asks — whether a room may still be opened in Agent mode — which reads
// `effectiveConversationMode` for the sentence it has to say when the answer is no. It is NOT a new
// coupling: the same import stood in the routes file this list already holds, and the alternative
// was landing it beside its probe in `agent-sessions/conversation-agent.ts`, which would have made
// the session dispatcher a store reader and widened this set for a line budget rather than for an
// argument (ISS-1078).
const STORE_READERS_OUTSIDE = [
  'assistant/conversation-access.ts',
  'assistant/conversation-adapter.ts',
  'assistant/conversation-agent-offer.ts',
  'assistant/conversation-member-routes.ts',
  'assistant/conversation-routes.ts',
  'assistant/conversation-send.ts',
  'assistant/conversation-turn.ts',
  'assistant/vision.ts',
];

function sourceFilesUnder(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = `${root}${entry.name}`;
    if (entry.isDirectory()) out.push(...sourceFilesUnder(`${full}/`));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

function storeImportsIn(text: string): string[] {
  return [...text.matchAll(/from '(?:\.\.\/)+conversations\/([A-Za-z0-9_.-]+)'/g)].map(
    (m) => m[1] as string,
  );
}

describe('the conversation store knows no transport', () => {
  it('has store files to measure', () => {
    expect(storeFiles().length).toBeGreaterThan(3);
  });

  // cm:guard this is the structural half of "Rocket.Chat becomes an adapter": the machine was extracted from 49 Rocket.Chat files, and the only thing that keeps it extracted is that naming one here fails CI. `outbound.test.ts` holds the same shape over the single delivery door (ISS-1001 criterion 32).
  it('names no transport in any store module', () => {
    const offences: string[] = [];
    for (const file of storeFiles()) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      for (const word of TRANSPORT_WORDS) {
        if (text.includes(word)) offences.push(`${file} names "${word}"`);
      }
    }
    expect(offences).toEqual([]);
  });

  // cm:guard the OTHER direction, and the one ISS-1001's criterion 35 was about: NO adapter tree reaches the store. This was three named Rocket.Chat files until the turn runner took the turn path out of that tree (ISS-1002); it is zero now and an exception list here is what would undo it.
  // cm:guard the modules named below are the adapter CONTRACT and the neutral turn, which an adapter is meant to import — widening this set is how the store's own functions come back one re-export at a time, so a new name here needs the same argument the runner needed.
  it('is reached from no adapter tree, anywhere under integrations', () => {
    const root = fileURLToPath(new URL('../integrations/', import.meta.url));
    const offences: string[] = [];
    for (const file of sourceFilesUnder(root)) {
      for (const imported of storeImportsIn(readFileSync(file, 'utf8'))) {
        if (ADAPTER_FACING.includes(imported)) continue;
        offences.push(`${file.slice(root.length)} imports conversations/${imported}`);
      }
    }
    expect(offences.sort()).toEqual([]);
  });

  it('is reached from outside this directory only by the names frozen here', () => {
    const src = fileURLToPath(new URL('../', import.meta.url));
    const reaching = sourceFilesUnder(src)
      .filter((f) => !f.startsWith(dir))
      .filter((f) =>
        /from '[^']*conversations\/(store|participants)\.js'/.test(readFileSync(f, 'utf8')),
      )
      .map((f) => f.slice(src.length))
      .sort();
    expect(reaching).toEqual(STORE_READERS_OUTSIDE);
  });

  it('imports nothing from the integrations tree', () => {
    const offences: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const text = readFileSync(`${dir}${file}`, 'utf8');
      if (/from '(\.\.\/)+integrations\//.test(text)) offences.push(`${file}`);
    }
    expect(offences).toEqual([]);
  });
});
