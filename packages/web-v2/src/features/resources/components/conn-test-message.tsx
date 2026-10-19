/** A Test connection answer, the git host's own words on a line of their own (ISS-1421 r11). */
export function ConnTestMessage({ message }: { message: string }) {
  const seen = new Map<string, number>();
  const lines = message.split("\n").map((line) => {
    const n = (seen.get(line) ?? 0) + 1;
    seen.set(line, n);
    return { key: `${n}:${line}`, line };
  });
  return (
    <>
      {lines.map(({ key, line }) => (
        <span key={key} className="block">
          {line}
        </span>
      ))}
    </>
  );
}
