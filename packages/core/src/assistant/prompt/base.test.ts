// ISS-1229 r33, judge-92: asked nothing, a room's assistant filed an issue and commented on another from
// casual chat, because the method told it to record whatever "needs recording". A tracker write is now
// made on a person's request, and every door's prompt says so; reading stays free.

import { describe, expect, it } from 'vitest';
import { forgeCliTool } from '../tools/forge-cli-tool.js';
import { composeLayers } from './layer.js';
import { METHOD_LAYERS } from './layers.js';

describe('the method every door renders', () => {
  const method = composeLayers(METHOD_LAYERS);

  it('writes to the tracker only on a request, and says a remark is not one', () => {
    expect(method).toContain('WRITE TO THE TRACKER ONLY WHEN A PERSON ASKED FOR THAT WRITE');
    expect(method).toContain(
      'a remark that mentions work, a plan or a\n  problem is not a request',
    );
    expect(method).toContain('Reading the tracker needs nobody');
  });

  it('acts on what it is asked, never on whatever it judges needs recording', () => {
    expect(method).not.toMatch(/when something needs recording/);
    expect(method).toContain('when a person asks you to record or follow');
  });

  it('carries the same rule in the forge tool the model calls', () => {
    const tool = forgeCliTool({ principal: null as never, projectSlug: null });
    expect(tool.description).toContain(
      'file, comment or attach only when a person asked for that write',
    );
  });
});
