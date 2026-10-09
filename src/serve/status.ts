import { randomBytes, timingSafeEqual } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Daemon } from "./daemon.js";

export type StatusSource = Pick<Daemon, "runs" | "patch" | "command">;
export type StatusServer = { port: number; token: string; close(): Promise<void> };

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

/** Localhost-only API for `autoforge status` and the future menu-bar app. */
export async function startStatusServer(
  daemon: StatusSource,
  stateDir: string,
): Promise<StatusServer> {
  const token = randomBytes(32).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Browsers always send Origin on cross-site requests; nothing legitimate here does.
    if (req.headers.origin !== undefined)
      return send(res, 403, { error: "browser requests are refused" });
    const auth = Buffer.from(req.headers.authorization ?? "");
    if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) {
      return send(res, 401, { error: "missing or wrong token (see status.json)" });
    }
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    const m = /^\/runs(?:\/([^/]+)\/(patch|publish|discard))?$/.exec(path);
    if (!m) return send(res, 404, { error: "not found" });
    const [, rawId, action] = m;
    if (!rawId || !action) {
      return req.method === "GET"
        ? send(res, 200, daemon.runs())
        : send(res, 405, { error: "use GET" });
    }
    const issueId = decodeURIComponent(rawId);
    if (action === "patch") {
      if (req.method !== "GET") return send(res, 405, { error: "use GET" });
      const patch = await daemon.patch(issueId);
      if (patch === null) return send(res, 404, { error: "no patch for this issue" });
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(patch);
      return;
    }
    if (req.method !== "POST") return send(res, 405, { error: "use POST" });
    const outcome = await daemon.command(
      issueId,
      action === "publish" ? { kind: "publish", force: false } : { kind: "discard" },
    );
    if (!outcome) return send(res, 404, { error: "unknown issue" });
    send(res, outcome.ok ? 202 : 409, outcome);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) =>
      send(res, 500, { error: e instanceof Error ? e.message : String(e) }),
    );
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const file = join(stateDir, "status.json");
  await rm(file, { force: true }); // so the mode below applies to a new file
  await writeFile(file, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
  return {
    port,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(file, { force: true });
    },
  };
}
