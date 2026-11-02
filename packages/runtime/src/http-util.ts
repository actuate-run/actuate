import type { Row } from "@actuate/sdk";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export type LinkInfo =
  | { kind: "approval"; step: string; approve: boolean; message: string | null }
  | { kind: "input"; step: string; prompt: string; initial: string | null; maxLength: number };

/**
 * The page behind a signed link. GET renders a form and only POST acts, so
 * link previews in chat apps and email scanners can never decide anything.
 * `info` comes from RunManager.describeLink (null: invalid, expired or used).
 */
export function approvalPage(actuator: string, token: string, info: LinkInfo | null, result?: string): string {
  let body: string;
  if (result) {
    body = `<h1>Done</h1><p>${escapeHtml(result)}</p>`;
  } else if (!info) {
    body = `<h1>Link expired</h1><p>This link is invalid, has expired, or was already used.</p>`;
  } else if (info.kind === "input") {
    body = `<h1>${escapeHtml(actuator)}</h1><p class="q">${escapeHtml(info.prompt)}</p>
<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}">
<label for="text">Your answer</label>
<textarea id="text" name="text" rows="6" maxlength="${info.maxLength}" required>${escapeHtml(info.initial ?? "")}</textarea>
<label for="by">Your name (optional)</label>
<input id="by" name="by" maxlength="120" autocomplete="name">
<button type="submit">Send answer</button></form>`;
  } else {
    const verb = info.approve ? "Approve" : "Reject";
    body = `<h1>${verb} “${escapeHtml(info.step)}”</h1>
${info.message ? `<p class="q">${escapeHtml(info.message)}</p>` : ""}<p>For <strong>${escapeHtml(actuator)}</strong>.</p>
<form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}">
<label for="note">Note (optional)</label>
<textarea id="note" name="note" rows="3" maxlength="2000"></textarea>
<label for="by">Your name (optional)</label>
<input id="by" name="by" maxlength="120" autocomplete="name">
<button type="submit" class="${info.approve ? "" : "reject"}">${verb}</button></form>`;
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${escapeHtml(actuator)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:12vh auto;padding:0 1rem;color:#141413;background:#fafaf8}
h1{font-size:1.4rem;margin:0 0 .75rem}.q{padding:.75rem 1rem;border-left:3px solid #c2410c;background:#f2f0ec;border-radius:.4rem;white-space:pre-wrap}
label{display:block;margin:1rem 0 .35rem;font-size:.9rem;color:#5c5a55}
textarea,input#by{width:100%;box-sizing:border-box;font:inherit;padding:.6rem;border:1px solid #d8d5cf;border-radius:.5rem;background:#fff;color:inherit}
button{margin-top:1rem;font:inherit;padding:.6rem 1.4rem;border-radius:.5rem;border:0;background:#141413;color:#fff;cursor:pointer}
button.reject{background:#b42318}
@media (prefers-color-scheme:dark){body{background:#121211;color:#eeece8}.q{background:#1d1c1a}textarea,input#by{background:#1a1918;border-color:#3a3835}button{background:#eeece8;color:#141413}button.reject{background:#f97066;color:#141413}label{color:#a8a59e}}</style></head>
<body>${body}</body></html>`;
}

export function toCsv(columns: string[], rows: Row[]): string {
  const cell = (v: unknown) => {
    if (v === null || v === undefined) return "";
    let s = v instanceof ArrayBuffer || v instanceof Uint8Array ? "[binary]" : String(v);
    // Spreadsheet formula injection: a leading = + - @ (or tab/CR) would execute in Excel or Sheets.
    if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}
