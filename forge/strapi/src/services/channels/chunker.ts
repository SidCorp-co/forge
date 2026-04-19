export function chunkText(text: string, maxSize: number): string[] {
  if (text.length <= maxSize) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxSize) { chunks.push(remaining); break; }
    let cut = remaining.lastIndexOf('\n', maxSize);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', maxSize);
    if (cut <= 0) cut = maxSize;
    chunks.push(remaining.slice(0, cut));
    remaining = remaining.slice(cut).trimStart();
  }
  return chunks;
}
