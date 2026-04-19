/**
 * Split text into chunks at paragraph boundaries, preserving title in first chunk.
 */
export function chunkText(text: string, maxChunkSize = 2000): string[] {
  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current.length === 0) {
      current = trimmed;
    } else if (current.length + trimmed.length + 2 <= maxChunkSize) {
      current += '\n\n' + trimmed;
    } else {
      chunks.push(current);
      current = trimmed;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [text];
}
