/** A fragment as a sentence: its first letter capital and a full stop at the end, never two. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}
