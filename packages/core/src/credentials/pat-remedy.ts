import { patGrantCovers } from './pat-permissions.js';

/**
 * How a token that cannot do an act itself reaches the person who can: a token fenced to projects
 * never opens an account route, and no token mints or widens a token, so a refusal naming either
 * as the way out names a door its caller is refused at. The question door is the one a token
 * reaches a person through, and only where its grant holds `questions:write`.
 */
export function askAPersonDoor(grant: readonly string[] | null | undefined): string {
  if (patGrantCovers(grant ?? null, 'questions:write')) {
    return (
      'ask one with POST /api/questions, naming the issue you work as `issueId`, the change ' +
      'and why as `prompt`, and `serious: true`'
    );
  }
  return (
    "this token is not granted 'questions:write', so it cannot ask one at POST /api/questions " +
    "either: name the change in your run's report, where a person reads it"
  );
}
