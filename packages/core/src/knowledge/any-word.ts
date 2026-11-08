// The one match rule keyword recall holds for a project's entries and its org's rulings alike
// (ISS-1142): an entry matches where it holds ANY word of the query, and ranks by how much of it it
// holds. Before, a project entry had to hold EVERY word (`websearch_to_tsquery`) while an org ruling
// needed one, so a question phrased in a person's own words found the org's rulings and missed the
// project's lessons.

/** Each word of the query, letters and digits of any script, as lexemes OR'd together; null where it has none. */
export const anyWordQuery = (query: string): string | null => {
  const words = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
  return words.length > 0 ? words.join(' | ') : null;
};
