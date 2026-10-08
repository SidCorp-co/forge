import { describe, expect, it } from 'vitest';
import type { McpContext } from '../../lib/tool.js';
import { forgeMemoryNoteTool } from './forge-memory-note-tool.js';

// A note naming another project's issue by its bare key is read against this project's numbers,
// and reads stale or as the wrong issue, so the tool says how a foreign key is written.
describe('forge_memory.note', () => {
  it("tells the model to write another project's key with its slug", () => {
    const tool = forgeMemoryNoteTool({} as McpContext);
    expect(tool.description).toContain('`<slug> ISS-n`');
  });
});
