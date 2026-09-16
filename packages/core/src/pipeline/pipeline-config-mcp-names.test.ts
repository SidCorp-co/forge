/**
 * Which `mcpServers` names a pipeline config may declare, and — the part ISS-1071 is about — WHICH
 * of the two schemas refuses them.
 *
 * Split out of `pipeline-config-schema.test.ts` because it is a different subject: that file asks
 * what the config document may contain, this one asks which door is allowed to say no.
 */

import { describe, expect, it } from 'vitest';
import { pipelineConfigPatchSchema, pipelineConfigSchema } from './pipeline-config-schema.js';

// ISS-1071 rule 7 — the check is on the WRITE schema and the asymmetry IS the assertion: four
// control-plane readers `safeParse` a STORED document and take a silent branch on failure, so a name
// check on the read side turns one stale document into a project that dispatches nothing and reports
// nothing (the ISS-807 shape).
describe('mcpServers validation (ISS-623 W1 / ISS-1071 rule 7)', () => {
  it('the WRITE schema rejects an unknown true-shorthand at the project default', () => {
    expect(() => pipelineConfigPatchSchema.parse({ mcpServers: { shop: true } })).toThrow(
      /mcpServers entry.*shop.*not a known catalog server/,
    );
  });

  it('the WRITE schema rejects an unknown true-shorthand per-state', () => {
    expect(() =>
      pipelineConfigPatchSchema.parse({
        states: { awaiting_release: { mcpServers: { shp: true } } },
      }),
    ).toThrow(/mcpServers entry.*shp.*not a known catalog server/);
  });

  // ISS-1038 — `epodsystem: true` used to be the legal way to let an agent use an integration. The
  // refusal must send the operator to the binding, not to a second settings tab.
  it('the WRITE schema now rejects a PROVIDER name, and says where the switch moved to', () => {
    expect(() => pipelineConfigPatchSchema.parse({ mcpServers: { epodsystem: true } })).toThrow(
      /agent-access switch on that integration's binding/,
    );
    expect(() =>
      pipelineConfigPatchSchema.parse({ mcpServers: { epodsystem_store_a: true } }),
    ).toThrow(/not a known catalog server/);
  });

  // If this goes red the check has crept back onto the canonical schema and every project that
  // stored a sentinel before this deploy goes dark in silence.
  it('the READ schema refuses NONE of them, so a stored document still parses', () => {
    for (const doc of [
      { mcpServers: { epodsystem: true } },
      { mcpServers: { epodsystem_store_a: true } },
      { mcpServers: { shop: true } },
      { states: { awaiting_release: { mcpServers: { shp: true } } } },
    ]) {
      expect(() => pipelineConfigSchema.parse(doc)).not.toThrow();
    }
  });

  it('both schemas accept a known catalog name', () => {
    expect(pipelineConfigSchema.parse({ mcpServers: { playwright: true } }).mcpServers).toEqual({
      playwright: true,
    });
    expect(
      pipelineConfigPatchSchema.parse({ mcpServers: { playwright: true } }).mcpServers,
    ).toEqual({ playwright: true });
  });

  it('object-valued custom specs and false/null opt-outs pass both, unchanged', () => {
    const doc = {
      mcpServers: {
        custom: { type: 'stdio', command: 'foo', args: [], env: {} },
        disabled: false,
        cleared: null,
      },
    };
    expect(pipelineConfigSchema.parse(doc).mcpServers).toEqual(doc.mcpServers);
    expect(pipelineConfigPatchSchema.parse(doc).mcpServers).toEqual(doc.mcpServers);
  });
});
