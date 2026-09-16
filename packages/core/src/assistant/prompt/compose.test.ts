/**
 * ISS-1057 — the layers, the order each door renders them in, and the benchmark tasks each one
 * claims to be measured by.
 *
 * A layer split that nobody can check is prose moved between files. What makes it a seam is that
 * the composer's refusals bite, the order is asserted rather than assumed, and every layer names
 * the tasks whose pass^k a change to it has to move.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ASSISTANT_METHOD_GUIDE } from '../../guides/assistant-method-guide.js';
import { loadTasks } from '../bench/tasks/index.js';
import { composeLayers, LayerComposeError, type LayerId, type PromptLayer } from './layer.js';
import { ALL_LAYERS, METHOD_LAYERS, ROCKETCHAT_DOOR_LAYERS, WEB_DOOR_LAYERS } from './layers.js';

const HERE = dirname(fileURLToPath(import.meta.url));

const layer = (id: string, text: string, benchTasks: string[] = []): PromptLayer =>
  ({ id, benchTasks, text }) as PromptLayer;

describe('composeLayers', () => {
  it('joins the layers in the order it is given them (criterion 1)', () => {
    const out = composeLayers([layer('base', 'one'), layer('tools', 'two')], {});
    expect(out).toBe('one\n\ntwo');
    expect(composeLayers([layer('tools', 'two'), layer('base', 'one')], {})).toBe('two\n\none');
  });

  it('fills every token from the values map (criterion 2)', () => {
    expect(
      composeLayers([layer('identity', 'hello {who} of {where}')], { who: 'a', where: 'b' }),
    ).toBe('hello a of b');
  });

  it('drops the line whose value is null (criterion 3)', () => {
    expect(composeLayers([layer('door-web', 'keep\nfor {askedBy}')], { askedBy: null })).toBe(
      'keep',
    );
  });

  it('leaves every other line of that layer standing (criterion 4)', () => {
    const out = composeLayers([layer('door-web', 'first\nfor {askedBy}\nlast')], { askedBy: null });
    expect(out).toBe('first\nlast');
  });

  // cm:guard a token the door does not name THROWS and a null one drops its line, and the two may
  // not be folded: dropping on both makes a typo in a token an instruction that silently leaves the
  // persona, which no reader of the rendered text can see (criterion 5).
  it('throws naming the layer and the token for a token the values map does not name (criterion 5)', () => {
    expect(() =>
      composeLayers([layer('tools', 'reads {nobodyNamesThis}')], { askedBy: null }),
    ).toThrow(LayerComposeError);
    expect(() => composeLayers([layer('tools', 'reads {nobodyNamesThis}')], {})).toThrow(
      /layer "tools" reads \{nobodyNamesThis\}/,
    );
  });

  it('does not read a JSON example brace as a token', () => {
    expect(composeLayers([layer('tools', 'send {"argv":["new"]}')], {})).toBe(
      'send {"argv":["new"]}',
    );
  });
});

describe('the layers this repository ships', () => {
  it('is exactly seven modules with the declared ids (criterion 6)', () => {
    const files = readdirSync(HERE)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .filter((f) => f !== 'layer.ts' && f !== 'layers.ts');
    expect(files.sort()).toEqual([
      'base.ts',
      'door-rocketchat.ts',
      'door-web-agent.ts',
      'door-web.ts',
      'identity.ts',
      'linking.ts',
      'tools.ts',
    ]);
    expect(ALL_LAYERS.map((l) => l.id).sort()).toEqual([
      'base',
      'door-rocketchat',
      'door-web',
      'door-web-agent',
      'identity',
      'linking',
      'tools',
    ]);
  });

  // cm:guard "no code" is asserted over the FILE, because that is the property the split claims: a
  // layer that grew a function would be a second reader of its own text and the composer would stop
  // being the only one (criterion 11).
  it('exports no function from any layer module (criterion 11)', () => {
    for (const file of ALL_LAYERS.map((l) => `${l.id === 'base' ? 'base' : l.id}.ts`)) {
      const src = readFileSync(join(HERE, file), 'utf8');
      expect(src, file).not.toMatch(/export\s+(async\s+)?function/);
      expect(src, file).not.toMatch(/export\s+const\s+\w+\s*=\s*\(/);
    }
  });
});

/**
 * Which benchmark task measures which layer, and why.
 */
// cm:guard FROZEN here as well as declared on the layer, and the two are compared: a header held
// only to "names a shipped task id" stays green when a layer is repointed at an unrelated task,
// which is the layer-to-measurement contract quietly going away (codex F2). A pair added or moved
// has to be justified in this table in the same change.
const MANIFEST: Record<LayerId, Record<string, string>> = {
  identity: {
    'memory-question':
      'the reply has to speak as this project’s assistant for the fact to be its own',
    'summary-in-style': 'the summary is of the project this layer names',
  },
  base: {
    'memory-question': 'investigate-before-answering is this layer’s',
    'memory-followup': 'the same rule across two turns',
    'out-of-reach-tests': 'own-what-is-addressed-to-you, and refusing without delegating',
    'vietnamese-count': 'answer in the language the person wrote in',
    'summary-in-style': 'lead with what you found, and answer concisely',
    'long-context-needle': 'read the whole message before answering: the fact sits mid-text',
    'long-context-thread':
      'hold the facts of eight turns and answer from them, not by asking again',
  },
  tools: {
    'one-issue-by-key': 'the carried `issue ISS-<n>` form is what removes the `-h` round',
    'open-issues-linked': 'the carried `issue --status` form, and the call budget it saves',
    'filing-guidance': 'the filing rules and the carried `new` form',
    'preference-restore': 'never say a write landed that you did not read back',
    'project-issue-counts':
      'the carried `issue --status` form read once per status, counted, never guessed',
    'project-pipeline-states':
      'the project’s own pipeline read from the tracker, in its declared order',
    'project-waiting-issue':
      'the `forge issue --status needs_info` form, the sentence that a draft is unfiled and not waiting, and the link shape on the one it names',
    'memory-store-recall':
      'forge_memory_note to keep a fact, forge_memory_search to read it back in a new room',
    'memory-correction':
      'a correction overwrites the note; the search returns the newer value, not both',
  },
  linking: {
    'one-issue-by-key': 'the link shape and where a documentId comes from',
    'open-issues-linked': 'the same, once per issue in a list',
  },
  'door-web': {
    'out-of-reach-tests': 'what this surface cannot do, and the Agents screen it names instead',
    'preference-bullets': 'the door where a preference is set',
    'memory-followup': 'the multi-turn rule that is true here and false in a room',
  },
  'door-web-agent': {
    'out-of-reach-tests':
      'the same task read from the other side: this door CAN reach a file, so what it measures here is the absence of the refusal `door-web` owes',
    'preference-bullets':
      'the door where a preference is set, in the other mode of the same surface',
    'memory-followup': 'the multi-turn rule, which is true of both modes of the web app',
  },
  'door-rocketchat': {},
};

describe('every layer names the tasks that measure it', () => {
  const shipped = new Set(loadTasks().map((t) => t.id));

  it('names only task ids the benchmark ships (criterion 7)', () => {
    for (const l of ALL_LAYERS) {
      for (const id of l.benchTasks) expect(shipped, `${l.id} -> ${id}`).toContain(id);
    }
  });

  // cm:guard an empty header is legal and LOUD: the benchmark walks the browser door only, so the
  // room layer has no task, and borrowing one from another door would be a measurement claim
  // nobody can take (criterion 8).
  it('says why, where it names none (criterion 8)', () => {
    for (const l of ALL_LAYERS) {
      if (l.benchTasks.length > 0) expect(l.whyUnmeasured, l.id).toBeUndefined();
      else expect(l.whyUnmeasured, l.id).toEqual(expect.stringMatching(/\S/));
    }
  });

  it('matches the frozen manifest, pair for pair (criterion 9)', () => {
    for (const l of ALL_LAYERS) {
      expect([...l.benchTasks].sort(), l.id).toEqual(Object.keys(MANIFEST[l.id]).sort());
      for (const reason of Object.values(MANIFEST[l.id])) expect(reason.length).toBeGreaterThan(20);
    }
  });

  // cm:guard the other direction, which is the one a reader of the benchmark needs: a task no layer
  // claims is a figure that moves with nobody owning it (criterion 10).
  it('leaves no shipped task unclaimed by some layer (criterion 10)', () => {
    const claimed = new Set(ALL_LAYERS.flatMap((l) => [...l.benchTasks]));
    expect([...shipped].filter((id) => !claimed.has(id))).toEqual([]);
  });
});

describe('the order each door composes', () => {
  it('is identity, base, tools, linking, then the web door (criterion 20)', () => {
    expect(WEB_DOOR_LAYERS.map((l) => l.id)).toEqual([
      'identity',
      'base',
      'tools',
      'linking',
      'door-web',
    ]);
  });

  it('is identity, base, tools, linking, then the room (criterion 21)', () => {
    expect(ROCKETCHAT_DOOR_LAYERS.map((l) => l.id)).toEqual([
      'identity',
      'base',
      'tools',
      'linking',
      'door-rocketchat',
    ]);
  });

  it('gives the guide the base and tools layers, in that order (criterion 18)', () => {
    expect(METHOD_LAYERS.map((l) => l.id)).toEqual(['base', 'tools']);
  });

  // cm:guard the EQUALITY and not only the order, which is what criterion 18 actually says: the
  // order test passes for a guide that composed the right layers and then appended a sentence of
  // its own, which is exactly the second copy ISS-1007 removed and this split has to keep removed.
  it('composes the guide body from those layers and adds nothing (criterion 18)', () => {
    expect(ASSISTANT_METHOD_GUIDE.body).toBe(composeLayers(METHOD_LAYERS));
  });
});

describe('what the layers had to say to close ISS-1057', () => {
  const tools = ALL_LAYERS.find((l) => l.id === 'tools') as PromptLayer;
  const linking = ALL_LAYERS.find((l) => l.id === 'linking') as PromptLayer;

  // cm:guard asserted as a property of every `-h` SENTENCE rather than as the absence of the
  // string: `-h` still has a legitimate mention — the way out for a verb whose form is not carried
  // — and a test reading for the bare substring would have to choose between forbidding that and
  // catching nothing (criterion 15).
  it('mentions -h only as the way out for a verb whose form is not carried (criterion 15)', () => {
    const sentences = (text: string): string[] =>
      text.split(/(?<=[.;])\s+|\n/).filter((s) => s.includes('-h'));
    for (const s of sentences(tools.text)) expect(s).toMatch(/does not carry/);
    expect(sentences(tools.text).length).toBeGreaterThan(0);
  });

  it('names the one shape the web opens (criterion 16)', () => {
    expect(linking.text).toContain('/projects/{projectSlug}/issues/<documentId>');
    expect(linking.text).toContain('it is a UUID');
  });

  it('names the shapes the web does not open (criterion 17)', () => {
    expect(linking.text).toContain('an issue key');
    expect(linking.text).toContain('a bare number');
    expect(linking.text).toContain('`#/` route');
  });

  // cm:guard the layer POINTS AT the carried forms and does not restate them: `READ_FORMS` is
  // generated into the `forge` tool's own description and held to the bundled CLI's Usage lines by
  // `forge-cli-forms.test.ts`, so a copy here would be the one thing that can go stale silently.
  // The plan's criterion 12 said the layer carries the forms; it points at them, and the correction
  // on the issue says so (criterion 12).
  it('tells the model the forms are already in the tool description (criterion 12)', () => {
    expect(tools.text).toContain('the forms you need are already in its description');
  });
});
