// The letters an avatar or a project mark draws (ISS-865, ui-copy-rule 10): letters only, never a
// bracket, digit or mark from the name ("Epod (ops)" reads "EO", never "E("). An email reads from its
// local part. Two words give their first letters, one word its first two; nothing gives "?".

const WORD = /\p{L}+/gu;

export function initialsOf(name: string): string {
  const at = name.indexOf("@");
  const base = at > 0 ? name.slice(0, at) : name;
  const words = base.match(WORD) ?? [];
  const [first, second] = words;
  if (!first) return "?";
  const letters = second ? `${first[0] ?? ""}${second[0] ?? ""}` : first.slice(0, 2);
  return letters.toLocaleUpperCase();
}
