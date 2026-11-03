import ts from "typescript";

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  severity: "error" | "warning";
  rule: string;
  message: string;
}

const PROVIDERS = new Set(["messaging", "payment", "llm", "http"]);
const WRITE_SQL = /^\s*(INSERT|UPDATE|DELETE|REPLACE)\b/i;

/**
 * Replay-safety linter. `run` is re-executed from the top after every pause,
 * so side effects and non-determinism must sit inside `ctx.step.do`.
 *
 * Errors: `fetch`, provider calls (`ctx.payment.*` etc.), `Date.now()`,
 * `new Date()`, `Math.random()` and `crypto.randomUUID()` outside a step.
 * `ctx.db.commitWithStep()` outside a step.
 * Warnings: literal INSERT/UPDATE/DELETE through `ctx.db` outside a step, including
 * the entries of a `ctx.db.batch([...])`. A statement built with `ctx.db.statement`
 * isn't flagged on its own: building one has no effect until it is run.
 */
export function checkSource(fileName: string, source: string): Diagnostic[] {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diagnostics: Diagnostic[] = [];

  const report = (node: ts.Node, severity: Diagnostic["severity"], rule: string, message: string) => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    diagnostics.push({ file: fileName, line: line + 1, column: character + 1, severity, rule, message });
  };

  const runFunctions = findRunFunctions(sf);
  for (const fn of runFunctions) {
    const ctxName = fn.parameters[0] && ts.isIdentifier(fn.parameters[0].name) ? fn.parameters[0].name.text : undefined;
    if (!ctxName || !fn.body) continue;

    const visit = (node: ts.Node, inStep: boolean): void => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const chain = propertyChain(callee);

        // ctx.step.do(name, [options,] fn): the callback is a step body.
        if (chain && chain[0] === ctxName && chain[1] === "step" && chain[2] === "do" && chain.length === 3) {
          const last = node.arguments[node.arguments.length - 1];
          for (const arg of node.arguments) visit(arg, inStep || arg === last);
          return;
        }

        if (!inStep && chain) {
          const dotted = chain.join(".");
          if (dotted === "fetch" || dotted === "globalThis.fetch") {
            report(node, "error", "no-fetch-outside-step", "fetch() outside ctx.step.do runs again on every replay. Wrap it in a step.");
          } else if (chain[0] === ctxName && chain.length >= 3 && PROVIDERS.has(chain[1]!)) {
            report(node, "error", "no-provider-outside-step", `${ctxName}.${chain[1]}.${chain[2]}() must be called inside ctx.step.do.`);
          } else if (dotted === "Date.now" || dotted === "Math.random" || dotted === "crypto.randomUUID" || dotted === "performance.now") {
            report(node, "error", "no-nondeterminism-outside-step", `${dotted}() gives a different value on each replay. Compute it inside ctx.step.do.`);
          } else if (chain[0] === ctxName && chain[1] === "db" && chain[2] === "commitWithStep" && chain.length === 3) {
            report(node, "error", "no-commit-outside-step", `${ctxName}.db.commitWithStep() queues writes for the step that is running, so it must be called inside ctx.step.do.`);
          } else if (chain[0] === ctxName && chain[1] === "db" && chain[2] === "batch" && chain.length === 3) {
            const list = node.arguments[0];
            for (const el of list && ts.isArrayLiteralExpression(list) ? list.elements : []) {
              if (isWriteStatement(el, ctxName)) report(el, "warning", "db-write-outside-step", "This write runs again on every replay. Put the batch inside ctx.step.do.");
            }
          } else if (chain[0] === ctxName && chain[1] === "db" && (chain[2] === "query" || chain[2] === "first")) {
            const sql = node.arguments[0];
            if (sql && (ts.isStringLiteral(sql) || ts.isNoSubstitutionTemplateLiteral(sql)) && WRITE_SQL.test(sql.text)) {
              report(node, "warning", "db-write-outside-step", "This write runs again on every replay. Put it inside ctx.step.do.");
            }
          }
        }
      }
      if (!inStep && ts.isTaggedTemplateExpression(node)) {
        const chain = propertyChain(node.tag);
        if (chain?.[0] === ctxName && chain[1] === "db" && chain[2] === "sql") {
          const head = ts.isNoSubstitutionTemplateLiteral(node.template) ? node.template.text : node.template.head.text;
          if (WRITE_SQL.test(head)) report(node, "warning", "db-write-outside-step", "This write runs again on every replay. Put it inside ctx.step.do.");
        }
      }
      if (!inStep && ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Date" && !node.arguments?.length) {
        report(node, "error", "no-nondeterminism-outside-step", "new Date() gives a different value on each replay. Compute it inside ctx.step.do.");
      }
      ts.forEachChild(node, (child) => visit(child, inStep));
    };
    visit(fn.body, false);
  }
  return diagnostics.sort((a, b) => a.line - b.line || a.column - b.column);
}

/** A batch entry that writes: ctx.db.statement`INSERT ...`, or { sql: "UPDATE ..." }. */
function isWriteStatement(el: ts.Expression, ctxName: string): boolean {
  if (ts.isTaggedTemplateExpression(el)) {
    const chain = propertyChain(el.tag);
    if (chain?.[0] !== ctxName || chain[1] !== "db" || chain[2] !== "statement") return false;
    return WRITE_SQL.test(ts.isNoSubstitutionTemplateLiteral(el.template) ? el.template.text : el.template.head.text);
  }
  if (ts.isObjectLiteralExpression(el)) {
    for (const p of el.properties) {
      if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && p.name.text === "sql") {
        const v = p.initializer;
        return (ts.isStringLiteral(v) || ts.isNoSubstitutionTemplateLiteral(v)) && WRITE_SQL.test(v.text);
      }
    }
  }
  return false;
}

/** Find `run` functions in object literals passed to defineActuator(...). */
function findRunFunctions(sf: ts.SourceFile): ts.FunctionLikeDeclaration[] {
  const found: ts.FunctionLikeDeclaration[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "defineActuator") {
      const arg = node.arguments[0];
      if (arg && ts.isObjectLiteralExpression(arg)) {
        for (const prop of arg.properties) {
          if (!prop.name || !ts.isIdentifier(prop.name) || prop.name.text !== "run") continue;
          if (ts.isMethodDeclaration(prop)) found.push(prop);
          else if (ts.isPropertyAssignment(prop) && (ts.isArrowFunction(prop.initializer) || ts.isFunctionExpression(prop.initializer))) {
            found.push(prop.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

/** `a.b.c` → ["a","b","c"]; anything else (calls, element access) → null. */
function propertyChain(expr: ts.Expression): string[] | null {
  if (ts.isIdentifier(expr)) return [expr.text];
  if (ts.isPropertyAccessExpression(expr)) {
    const left = propertyChain(expr.expression);
    return left ? [...left, expr.name.text] : null;
  }
  return null;
}

export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.column}  ${d.severity === "error" ? "error" : "warn "}  ${d.message}  (${d.rule})`;
}
