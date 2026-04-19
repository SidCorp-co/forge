function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function markdownToTelegramHtml(md: string): string {
  // Fenced code blocks
  let result = md.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_m, lang, code) =>
      `<pre${lang ? ` language="${escapeHtml(lang)}"` : ""}>${escapeHtml(code.trimEnd())}</pre>`,
  );

  // Inline code (before other inline formatting)
  result = result.replace(/`([^`]+)`/g, (_m, code) => `<code>${escapeHtml(code)}</code>`);

  // Bold **text** or __text__
  result = result.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
  result = result.replace(/__(.+?)__/g, "<b>$1</b>");

  // Italic *text* or _text_
  result = result.replace(/\*(.+?)\*/g, "<i>$1</i>");
  result = result.replace(/_(.+?)_/g, "<i>$1</i>");

  // Links [text](url)
  result = result.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_m, text, url) => `<a href="${escapeHtml(url)}">${text}</a>`,
  );

  return result;
}
