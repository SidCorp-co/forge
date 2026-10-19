/** A Test connection answer, the git host's own words on a line of their own (ISS-1421 r11). */
export function ConnTestMessage({ message }: { message: string }) {
  return (
    <>
      {message.split("\n").map((line, i) => (
        <span key={`${i}-${line}`} className="block">
          {line}
        </span>
      ))}
    </>
  );
}
