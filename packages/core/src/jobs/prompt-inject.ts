// Splicing blocks into a job's prompt string right after its invocation line.

export function injectTurnLevelRules(
  promptString: string,
  turnLevelSystemPrompt: string | null | undefined,
): string {
  const tlSp = turnLevelSystemPrompt?.trim();
  if (!tlSp || tlSp.length === 0) return promptString;
  const block = [
    '',
    '## Pipeline Rules (this turn)',
    'These rules apply to this turn — apply them in addition to any session-level system prompt:',
    '',
    tlSp,
  ].join('\n');
  const firstNl = promptString.indexOf('\n');
  if (firstNl === -1) return `${promptString}${block}`;
  return `${promptString.slice(0, firstNl)}${block}${promptString.slice(firstNl)}`;
}

export function injectAfterInvocation(promptString: string, block: string): string {
  const b = block.trim();
  if (b.length === 0) return promptString;
  const wrapped = `\n\n${b}`;
  const firstNl = promptString.indexOf('\n');
  if (firstNl === -1) return `${promptString}${wrapped}`;
  return `${promptString.slice(0, firstNl)}${wrapped}${promptString.slice(firstNl)}`;
}
