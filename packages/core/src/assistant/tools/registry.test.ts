import { describe, expect, it } from 'vitest';
import type { McpContext } from '../../lib/tool.js';
import { forgeMemoryNoteTool } from './forge-memory-note-tool.js';
import { forgePreferencesTool } from './forge-preferences-tool.js';
import { buildRecordToolset, provideChatTools } from './registry.js';

// REQ-30 BC-3: a narrow door (the BA door) still offers the record tools, and only those: the
// provided specs marked `record`.

describe('buildRecordToolset', () => {
  it('serves only the provided tools marked record', () => {
    provideChatTools([
      { factory: forgePreferencesTool },
      { factory: forgeMemoryNoteTool, record: true },
    ]);
    const all = buildRecordToolset({ projectId: 'p' } as unknown as McpContext);
    expect(all.tools.map((t) => t.function.name)).toEqual(['forge_memory_note']);
  });

  it('refuses by name where no record tool was provided', () => {
    provideChatTools([{ factory: forgePreferencesTool }]);
    expect(() => buildRecordToolset({} as McpContext)).toThrow(/no provided tool is marked record/);
  });
});
