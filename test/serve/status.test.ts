import { existsSync } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startStatusServer, type StatusServer } from "../../src/serve/status.js";
import { readState, setup, step } from "./harness.js";

type Reply = { status: number; body: string };

function call(
  port: number,
  path: string,
  o: { method?: string; headers?: Record<string, string> } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: o.method ?? "GET", headers: o.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

let server: StatusServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** A daemon with one issue waiting for approval, and its status server. */
async function running() {
  const h = await setup();
  h.linear.addIssue({ id: "issue-1" });
  const d = h.make();
  await d.start();
  await step(d);
  server = await startStatusServer(d, h.dir);
  const auth = { Authorization: `Bearer ${server.token}` };
  return { ...h, d, port: server.port, auth };
}

describe("status endpoint", () => {
  it("writes status.json with mode 600 and removes it on close", async () => {
    const h = await running();
    const file = join(h.dir, "status.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const info = JSON.parse(await readFile(file, "utf8")) as { port: number; token: string };
    expect(info.port).toBe(h.port);
    expect(info.token).toMatch(/^[0-9a-f]{64}$/);
    await server?.close();
    server = undefined;
    expect(existsSync(file)).toBe(false);
  });

  it("leaves status.json alone on close when another instance has replaced it", async () => {
    const h = await running();
    const file = join(h.dir, "status.json");
    const theirs = JSON.stringify({ port: 1, token: "t", pid: process.ppid });
    await writeFile(file, theirs);
    await server?.close();
    server = undefined;
    expect(await readFile(file, "utf8")).toBe(theirs);
  });

  it("answers 401 without the right token and 403 to any request with an Origin", async () => {
    const h = await running();
    expect((await call(h.port, "/runs")).status).toBe(401);
    expect(
      (await call(h.port, "/runs", { headers: { Authorization: "Bearer nope" } })).status,
    ).toBe(401);
    expect(
      (await call(h.port, "/runs", { headers: { ...h.auth, Origin: "https://evil.example" } }))
        .status,
    ).toBe(403);
  });

  it("answers 401 to a wrong token of the right length", async () => {
    const h = await running();
    const wrong = { Authorization: `Bearer ${"0".repeat(64)}` };
    expect((await call(h.port, "/runs", { headers: wrong })).status).toBe(401);
  });

  it("answers 400 to a malformed percent-escape in the path", async () => {
    const h = await running();
    expect((await call(h.port, "/runs/%zz/patch", { headers: h.auth })).status).toBe(400);
  });

  it("lists runs without patches or logs, and serves a patch", async () => {
    const h = await running();
    const list = await call(h.port, "/runs", { headers: h.auth });
    expect(list.status).toBe(200);
    const runs = JSON.parse(list.body) as Record<string, unknown>[];
    expect(runs).toEqual([
      {
        issueId: "issue-1",
        identifier: "ENG-1",
        status: "awaiting_approval",
        repo: "o/r",
        ref: "main",
        queuedAt: "2026-10-09T12:00:00.000Z",
        updatedAt: "2026-10-09T12:00:00.000Z",
        issueUrl: "https://linear.app/acme/issue/ENG-1",
      },
    ]);
    const patch = await call(h.port, "/runs/issue-1/patch", { headers: h.auth });
    expect(patch.status).toBe(200);
    expect(patch.body).toContain("+changed");
  });

  it("keeps issueUrl current when the issue moves and its Linear URL changes", async () => {
    const h = await running();
    h.clock.advance(1000);
    h.linear.update("issue-1", { url: "https://linear.app/acme/issue/OPS-7" });
    await step(h.d);
    const runs = JSON.parse((await call(h.port, "/runs", { headers: h.auth })).body) as {
      issueUrl?: string;
    }[];
    expect(runs[0]?.issueUrl).toBe("https://linear.app/acme/issue/OPS-7");
  });

  it("publishes like /publish, then refuses a discard in the wrong state", async () => {
    const h = await running();
    const res = await call(h.port, "/runs/issue-1/publish", { method: "POST", headers: h.auth });
    expect(res.status).toBe(202);
    await h.d.idle();
    expect(h.linear.said("issue-1").at(-1)).toBe("Draft PR opened: https://github.com/o/r/pull/1");

    const discard = await call(h.port, "/runs/issue-1/discard", {
      method: "POST",
      headers: h.auth,
    });
    expect(discard.status).toBe(409);
    expect(JSON.parse(discard.body)).toEqual({
      ok: false,
      message:
        "`/discard` did nothing: it only works while a result is waiting for approval (current status: published).",
    });
    expect(h.linear.said("issue-1").at(-1)).toBe("Draft PR opened: https://github.com/o/r/pull/1");
  });

  it("discards like /discard and posts the comment", async () => {
    const h = await running();
    const res = await call(h.port, "/runs/issue-1/discard", { method: "POST", headers: h.auth });
    expect(res.status).toBe(202);
    expect(h.linear.said("issue-1").at(-1)).toBe("Discarded. Nothing was published.");
    expect((await readState(h.dir)).issues["issue-1"]?.status).toBe("discarded");
  });

  // Review Focus 5
  it.each([
    ["POST", "/runs/__proto__/publish", 404],
    ["POST", "/runs/constructor/discard", 404],
    ["POST", "/runs/unknown/publish", 404],
    ["GET", "/runs/__proto__/patch", 404],
    ["GET", "/runs/unknown/patch", 404],
    ["GET", "/runs/issue-1/publish", 405],
    ["POST", "/runs", 405],
    ["GET", "/nope", 404],
  ])("%s %s answers %i", async (method, path, expected) => {
    const h = await running();
    expect((await call(h.port, path, { method, headers: h.auth })).status).toBe(expected);
  });
});
