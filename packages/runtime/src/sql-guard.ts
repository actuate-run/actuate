import type { SqlValue } from "@actuate/sdk";

/**
 * Checks on SQL an actuator sends through `ctx.db`: the statements the hosted
 * platform refuses before they run, because one of them can do unbounded work
 * (recursive CTEs, blob and printf generators) or reach outside the database
 * (PRAGMA, ATTACH). `actuate dev` and `@actuate/cli/testing` apply them so code
 * that would be refused once deployed fails locally first; a self-hosted
 * runtime can apply them too.
 *
 * The checks work on tokens, not raw text, so comment markers inside string
 * literals (`'--'`, `'/*'`) can't hide the rest of a statement.
 */

export interface SqlToken {
  /** ident: bare word or keyword; quoted: "x", `x` or [x]; string: 'x'; punct: one operator character. */
  kind: "ident" | "quoted" | "string" | "punct";
  /** Lowercased, with quotes removed and doubled quotes unescaped. */
  text: string;
}

/** SQLite's whitespace. Anything else, e.g. U+00A0, is part of an identifier. */
const SPACE = /[ \t\n\f\r]/;
/** Characters that end a bare identifier or keyword. */
const DELIMITERS = new Set([..."(),;.=<>!+-*/|%&~?:@$#'\"`[]{}^"]);

/** Split SQL into tokens the way SQLite's tokenizer sees it, dropping comments and whitespace. */
export function tokenizeSql(sql: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (SPACE.test(ch)) {
      i++;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
    } else if (ch === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (ch === "'" || ch === '"' || ch === "`" || ch === "[") {
      const close = ch === "[" ? "]" : ch;
      let text = "";
      i++;
      while (i < sql.length) {
        if (sql[i] === close) {
          if (close !== "]" && sql[i + 1] === close) {
            text += close;
            i += 2;
            continue;
          }
          i++;
          break;
        }
        text += sql[i++];
      }
      tokens.push({ kind: ch === "'" ? "string" : "quoted", text: text.toLowerCase() });
    } else if (DELIMITERS.has(ch)) {
      tokens.push({ kind: "punct", text: ch });
      i++;
    } else {
      let text = "";
      while (i < sql.length && !SPACE.test(sql[i]!) && !DELIMITERS.has(sql[i]!)) text += sql[i++];
      tokens.push({ kind: "ident", text: text.toLowerCase() });
    }
  }
  return tokens;
}

const isWord = (t: SqlToken | undefined, word: string) => t?.kind === "ident" && t.text === word;
/** SQLite accepts a string literal where it expects a name, so names include strings. */
const isName = (t: SqlToken | undefined) => t?.kind === "ident" || t?.kind === "quoted" || t?.kind === "string";
const isPunct = (t: SqlToken | undefined, p: string) => t?.kind === "punct" && t.text === p;

const RESERVED_PREFIX = /^(_actuate_|_cf_|sqlite_)/;
const REFUSED_FUNCTIONS = new Set(["randomblob", "zeroblob", "printf", "format", "load_extension", "readfile", "writefile"]);
const REFUSED_STATEMENTS = new Set(["pragma", "attach", "detach", "vacuum", "reindex"]);

/** Largest total of bound parameters in one statement on the hosted platform. */
export const MAX_SQL_PARAM_BYTES = 1024 * 1024;

/** Index just past the parenthesis that closes the one at `open`. */
function skipParens(tokens: SqlToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (isPunct(tokens[i], "(")) depth++;
    else if (isPunct(tokens[i], ")") && --depth === 0) return i + 1;
  }
  return tokens.length;
}

/**
 * SQLite makes a CTE that names itself in its own body recursive, with or
 * without the RECURSIVE keyword, so every self-referencing CTE is refused.
 */
function refuseRecursiveCtes(tokens: SqlToken[]): void {
  const unparsable = "Could not check this WITH clause. Write it as WITH name AS (SELECT ...).";
  for (let i = 0; i < tokens.length; i++) {
    if (!isWord(tokens[i], "with")) continue;
    let j = i + 1;
    if (isWord(tokens[j], "recursive")) throw new Error("Recursive queries are not allowed.");
    for (;;) {
      const name = tokens[j];
      if (!isName(name)) throw new Error(unparsable);
      j++;
      if (isPunct(tokens[j], "(")) j = skipParens(tokens, j);
      if (!isWord(tokens[j], "as")) throw new Error(unparsable);
      j++;
      if (isWord(tokens[j], "not")) j++;
      if (isWord(tokens[j], "materialized")) j++;
      if (!isPunct(tokens[j], "(")) throw new Error(unparsable);
      const end = skipParens(tokens, j);
      for (let k = j + 1; k < end; k++) {
        if (isName(tokens[k]) && tokens[k]!.text === name!.text) throw new Error("Recursive queries are not allowed.");
      }
      j = end;
      if (!isPunct(tokens[j], ",")) break;
      j++;
    }
  }
}

/**
 * Throw a readable `Error` if the hosted platform would refuse this statement:
 * reserved table names, generator and file functions, PRAGMA/ATTACH/DETACH/
 * VACUUM/REINDEX, recursive queries, or more than `maxParamBytes` of bound
 * parameters. The messages are the platform's.
 */
export function checkActuatorSql(sql: string, params: readonly SqlValue[] = [], maxParamBytes = MAX_SQL_PARAM_BYTES): void {
  if (typeof sql !== "string" || sql.length > 100_000) throw new Error("SQL must be a string of at most 100,000 characters.");
  const tokens = tokenizeSql(sql);
  let statementStart = true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (isName(t) && RESERVED_PREFIX.test(t.text)) throw new Error("Tables starting with _actuate_, _cf_ or sqlite_ are reserved.");
    if (isName(t) && REFUSED_FUNCTIONS.has(t.text) && isPunct(tokens[i + 1], "(")) throw new Error("That SQL function is not allowed.");
    if (statementStart && t.kind === "ident") {
      // EXPLAIN [QUERY PLAN] may prefix any statement.
      let k = i;
      if (isWord(tokens[k], "explain")) k++;
      if (isWord(tokens[k], "query") && isWord(tokens[k + 1], "plan")) k += 2;
      if (tokens[k]?.kind === "ident" && REFUSED_STATEMENTS.has(tokens[k]!.text)) {
        throw new Error("PRAGMA, ATTACH, DETACH, VACUUM and REINDEX are not allowed.");
      }
    }
    statementStart = isPunct(t, ";");
  }
  refuseRecursiveCtes(tokens);
  let bytes = 0;
  for (const p of params) {
    if (typeof p === "string") bytes += p.length * 3;
    else if (p instanceof Uint8Array || p instanceof ArrayBuffer) bytes += p.byteLength;
    else bytes += 8;
  }
  if (bytes > maxParamBytes) throw new Error(`Bound parameters may total at most ${Math.round(maxParamBytes / 1024)} KiB per statement.`);
}
