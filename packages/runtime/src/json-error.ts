/**
 * Why a JSON text did not parse, without quoting it: the engine's own message can include the text around the
 * error (`Unexpected token 'x', "...sk_live_..." is not valid JSON`), which may be part of a secret. Only the
 * position is kept, when the engine gives one: "is not valid JSON (line 1, column 24)" or "is not valid JSON".
 */
export function describeJsonError(err: unknown, text?: string): string {
  const message = err instanceof Error ? err.message : "";
  const m = /\bat position (\d+)(?: \(line (\d+) column (\d+)\))?/.exec(message);
  if (!m) return "is not valid JSON";
  if (m[2] && m[3]) return `is not valid JSON (line ${m[2]}, column ${m[3]})`;
  const offset = Number(m[1]);
  if (text === undefined || offset > text.length) return `is not valid JSON (at character ${offset + 1})`;
  const before = text.slice(0, offset).split("\n");
  return `is not valid JSON (line ${before.length}, column ${before.at(-1)!.length + 1})`;
}
