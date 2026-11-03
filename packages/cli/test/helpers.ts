import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded {
  method: string;
  path: string;
  body: unknown;
  headers: IncomingMessage["headers"];
}

/** A local HTTP server answering from `routes` ("METHOD /path" → JSON body, or [status, body]). Records every request. */
export async function fakeServer(routes: Record<string, unknown | [number, unknown] | ((body: unknown) => unknown)>) {
  const requests: Recorded[] = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const path = req.url ?? "/";
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method ?? "GET", path, body, headers: req.headers });
    let route = routes[`${req.method} ${path}`];
    if (typeof route === "function") route = (route as (b: unknown) => unknown)(body);
    const [status, payload] = route === undefined ? [404, { error: "not found" }] : Array.isArray(route) && typeof route[0] === "number" ? route : [200, route];
    res.writeHead(status as number, { "content-type": "application/json" }).end(JSON.stringify(payload));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { port, url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** Run the CLI in-process and capture what it prints. */
export async function runCli(args: string[], cwd?: string) {
  const { main } = await import("../src/cli.js");
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l), ...(cwd ? { cwd } : {}) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
