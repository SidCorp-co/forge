// Why a pending record could not be made an approval row, in the words its reader reads on the
// inbox: the field by its plain name and the rule it broke, never a schema path.

type Issue = {
  code: string;
  path: readonly PropertyKey[];
  message: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
  origin?: string;
  expected?: string;
};

/** The row's fields as the reader knows them; a field not here is named by its path. */
const FIELDS: Record<string, string> = {
  title: 'the title',
  key: 'the key',
  'askedBy.name': "the asker's name",
  'askedBy.kind': 'who asked',
  since: 'when it was asked',
  'opens.key': 'the key of the page it opens',
  approve: 'the approve act',
  decline: 'the decline act',
};

const fieldOf = (path: readonly PropertyKey[]): string => {
  const at = path.map(String).join('.');
  return FIELDS[at] ?? (at ? `the field ${at}` : 'the row');
};

function said(i: Issue): string {
  const field = fieldOf(i.path);
  const text = i.origin === 'string';
  if (i.code === 'too_big' && i.maximum !== undefined) {
    return text
      ? `${field} is longer than ${i.maximum} characters`
      : `${field} is over its limit of ${i.maximum}`;
  }
  if (i.code === 'too_small' && i.minimum !== undefined) {
    if (text && Number(i.minimum) === 1) return `${field} is empty`;
    return text
      ? `${field} is shorter than ${i.minimum} characters`
      : `${field} is under its floor of ${i.minimum}`;
  }
  if (i.code === 'invalid_type') return `${field} is missing or not a ${i.expected ?? 'value'}`;
  // a refinement already speaks in a sentence
  if (i.code === 'custom') return i.message;
  return `${field}: ${i.message}`;
}

/** A row's problems as a reader reads them: each field and the rule it broke, in words. */
export const problemOf = (issues: readonly Issue[]): string => issues.map(said).join('; ');
