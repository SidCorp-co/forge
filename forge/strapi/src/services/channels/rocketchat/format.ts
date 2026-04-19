/**
 * Convert standard markdown to Rocket.Chat-compatible format.
 * Rocket.Chat supports most standard markdown natively, but we normalize
 * a few patterns for consistency (e.g., ensure fenced code blocks use triple backticks).
 */
export function markdownToRocketChat(md: string): string {
  // Rocket.Chat supports standard markdown natively:
  // - **bold**, *italic*, ~~strikethrough~~
  // - ```code blocks```, `inline code`
  // - [links](url)
  // - > blockquotes
  // - ordered/unordered lists
  //
  // The main difference is mention format: @username instead of HTML.
  // Since agent output is standard markdown, it's mostly pass-through.

  // Normalize HTML bold/italic tags that some LLMs emit back to markdown
  let result = md.replace(/<b>(.*?)<\/b>/g, '**$1**');
  result = result.replace(/<i>(.*?)<\/i>/g, '*$1*');
  result = result.replace(/<code>(.*?)<\/code>/g, '`$1`');

  return result;
}
