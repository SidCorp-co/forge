// A criterion's statement as a person reads it (REQ-43 BC-7): the trace code an agent writes at its
// head — "(REQ-43 BC-1)", "[BC-3]", "REQ-7 BC-2:" — is agent text, so the person's view reads the
// statement without it and the developer's view reads it whole.

const CODE = String.raw`(?:REQ-\d+(?:\s+r\d+)?(?:\s+BC-\d+(?:\s*[,/&]\s*BC-\d+)*)?|BC-\d+(?:\s*[,/&]\s*BC-\d+)*)`;
const BRACKETED = new RegExp(String.raw`^\s*[([]\s*${CODE}\s*[)\]]\s*(?:[:—–-]\s*)?`);
const LED = new RegExp(String.raw`^\s*${CODE}\s*[:—–-]\s*`);

/** The statement without a trace code at its head; a statement that leads with none is returned as it is. */
export function withoutCriterionCode(statement: string): string {
  const rest = statement.replace(BRACKETED, "").replace(LED, "");
  return rest.trim() ? rest : statement;
}
