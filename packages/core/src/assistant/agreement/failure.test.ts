// A pressed write that core refused is told in the thread as a sentence naming what refused it,
// never the JSON the write answered with (ISS-439: the judge's probe F posted a problem document).

import { describe, expect, it } from 'vitest';
import { failureSentence } from './failure.js';

describe('the sentence a refused agreed write is told in', () => {
  it("reads a problem document's detail, and nothing of its JSON", () => {
    const problem = JSON.stringify({
      type: 'urn:forge:refusal:PERMISSION_FORBIDDEN',
      title: 'Permission forbidden',
      status: 403,
      detail: 'This needs project.write on project p; the caller holds viewer there',
      code: 'PERMISSION_FORBIDDEN',
    });
    const said = failureSentence(problem);
    expect(said).toBe(
      'It was refused: This needs project.write on project p; the caller holds viewer there. Nothing was written.',
    );
    expect(said).not.toMatch(/[{}"]/);
  });

  it('reads a refusal list, a nested error, and the CLI stream a tool answered with', () => {
    expect(failureSentence(JSON.stringify({ refusals: [{ detail: 'a' }, { detail: 'b' }] }))).toBe(
      'It was refused: a; b. Nothing was written.',
    );
    expect(failureSentence(JSON.stringify({ error: { message: 'needs project.write' } }))).toBe(
      'It was refused: needs project.write. Nothing was written.',
    );
    expect(
      failureSentence(
        JSON.stringify({
          exitCode: 1,
          stdout: '',
          stderr: JSON.stringify({ detail: 'Issue gone' }),
        }),
      ),
    ).toBe('It was refused: Issue gone. Nothing was written.');
  });

  it('keeps plain text as it is, and says so when nothing gives a reason', () => {
    expect(failureSentence('needs project.write on project p')).toBe(
      'It was refused: needs project.write on project p. Nothing was written.',
    );
    expect(failureSentence('{}')).toBe(
      'It was refused, and the refusal gave no reason. Nothing was written.',
    );
  });
});
