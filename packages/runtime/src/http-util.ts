import type { Row } from "@actuate/sdk";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * GET shows a confirmation form and POST applies it, so link previews in
 * chat apps and email scanners can never approve anything by fetching the URL.
 */
export function approvalPage(actuator: string, token: string, result?: string): string {
  let decision = "";
  try {
    const body = token.split(".")[0] ?? "";
    const claims = JSON.parse(atob(body.replace(/-/g, "+").replace(/_/g, "/"))) as { s?: string; d?: number };
    decision = `${claims.d === 1 ? "Approve" : "Reject"} “${claims.s ?? ""}”`;
  } catch {
    /* rendered without a label */
  }
  const content = result
    ? `<p>${escapeHtml(result)}</p>`
    : `<p>${escapeHtml(decision || "Confirm this decision")} for <strong>${escapeHtml(actuator)}</strong>?</p>
       <form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}">
       <button type="submit">${escapeHtml(decision.startsWith("Reject") ? "Reject" : "Approve")}</button></form>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Actuate approval</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#111}
button{font:inherit;padding:.6rem 1.4rem;border-radius:.5rem;border:0;background:#111;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}button{background:#eee;color:#111}}</style></head>
<body><h1>Approval</h1>${content}</body></html>`;
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
