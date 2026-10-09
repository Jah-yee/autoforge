import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { main, type CliIo } from "../../src/serve/cli.js";
import { startStatusServer } from "../../src/serve/status.js";

function capture(extra: Partial<CliIo> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = { out: (l) => out.push(l), err: (l) => err.push(l), env: {}, ...extra };
  return { out, err, io };
}

const tempDir = () => mkdtemp(join(tmpdir(), "autoforge-cli-"));
const config = { defaultRepo: "o/r", agent: { image: "autoforge-claude", command: ["true"] } };

async function withConfig(raw: unknown = config): Promise<string> {
  const d = await tempDir();
  await writeFile(join(d, "config.json"), JSON.stringify(raw));
  return d;
}

const gql = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });

describe("autoforge cli", () => {
  it("prints usage for --help, unknown commands and unknown flags", async () => {
    const help = capture();
    expect(await main(["--help"], help.io)).toBe(0);
    expect(help.out[0]).toContain("autoforge serve [--dir <path>]");
    const unknown = capture();
    expect(await main(["fly"], unknown.io)).toBe(2);
    expect(unknown.err[0]).toContain("Usage:");
    const flag = capture();
    expect(await main(["serve", "--nope"], flag.io)).toBe(2);
  });

  it("serve explains a missing config.json", async () => {
    const d = await tempDir();
    const t = capture();
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err[0]).toContain(`${join(d, "config.json")} not found`);
  });

  it("serve names the invalid config field", async () => {
    const d = await withConfig({ ...config, pollSeconds: 1 });
    const t = capture({ env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err).toEqual(["config.pollSeconds must be an integer of at least 10"]);
  });

  it("serve refuses an env file that others can read", async () => {
    const d = await withConfig();
    await writeFile(join(d, "env"), "LINEAR_API_KEY=k\n");
    await chmod(join(d, "env"), 0o644);
    const t = capture();
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err[0]).toContain(`Run: chmod 600 ${join(d, "env")}`);
  });

  it("serve requires LINEAR_API_KEY", async () => {
    const d = await withConfig();
    const t = capture({ env: { GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err[0]).toBe(
      "LINEAR_API_KEY is not set. Put it in ~/.autoforge/env or the environment.",
    );
  });

  it("serve reads the env file, polls Linear, serves status and shuts down on abort", async () => {
    const d = await withConfig();
    await writeFile(join(d, "env"), "LINEAR_API_KEY=lin_key\nGITHUB_TOKEN=gh_key\n", {
      mode: 0o600,
    });
    const stop = new AbortController();
    const auth: string[] = [];
    let statusDuringPoll = false;
    const fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      auth.push(new Headers(init.headers).get("authorization") ?? "");
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("viewer")) return gql({ viewer: { id: "u1", name: "Me" } });
      statusDuringPoll = existsSync(join(d, "status.json"));
      stop.abort();
      return gql({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    }) as typeof globalThis.fetch;
    const t = capture({ signal: stop.signal, fetch });

    expect(await main(["serve", "--dir", d], t.io)).toBe(0);
    expect(auth).toEqual(["lin_key", "lin_key"]);
    expect(statusDuringPoll).toBe(true);
    expect(existsSync(join(d, "status.json"))).toBe(false);
    const state = JSON.parse(await readFile(join(d, "state.json"), "utf8")) as { viewerId: string };
    expect(state.viewerId).toBe("u1");
    expect(t.out.map((l) => (JSON.parse(l) as { event: string }).event)).toEqual([
      "started",
      "stopped",
    ]);
  });

  it("serve prefers the process environment over the env file", async () => {
    const d = await withConfig();
    await writeFile(join(d, "env"), "LINEAR_API_KEY=file_key\nGITHUB_TOKEN=gh\n", { mode: 0o600 });
    const stop = new AbortController();
    const auth: string[] = [];
    const fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      auth.push(new Headers(init.headers).get("authorization") ?? "");
      stop.abort();
      return gql({ viewer: { id: "u1", name: "Me" } });
    }) as typeof globalThis.fetch;
    const t = capture({ signal: stop.signal, fetch, env: { LINEAR_API_KEY: "proc_key" } });
    await main(["serve", "--dir", d], t.io);
    expect(auth[0]).toBe("proc_key");
  });

  it("serve does not start the status server when the daemon fails to start", async () => {
    const d = await withConfig();
    const fetch = (async () => new Response("nope", { status: 500 })) as typeof globalThis.fetch;
    const t = capture({ fetch, env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(existsSync(join(d, "status.json"))).toBe(false);
    expect(t.err).toHaveLength(1);
  });

  it("serve reports an unreadable state.json in one line", async () => {
    const d = await withConfig();
    await mkdir(join(d, "state.json"));
    const t = capture({ env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err).toHaveLength(1);
    expect(t.err[0]).toMatch(/^autoforge: /);
    expect(t.err[0]).not.toContain("\n    at ");
  });

  it("status says when the daemon is not running", async () => {
    const t = capture();
    expect(await main(["status", "--dir", await tempDir()], t.io)).toBe(1);
    expect(t.err).toEqual(["autoforge serve is not running (no status.json)."]);
  });

  it("status says when status.json is stale", async () => {
    const d = await tempDir();
    await writeFile(join(d, "status.json"), JSON.stringify({ port: 1, token: "t" }));
    const t = capture();
    expect(await main(["status", "--dir", d], t.io)).toBe(1);
    expect(t.err[0]).toContain("not reachable (stale status.json?)");
  });

  it("status prints one line per issue", async () => {
    const d = await tempDir();
    const server = await startStatusServer(
      {
        runs: () => [
          {
            issueId: "i1",
            identifier: "ENG-1",
            status: "awaiting_approval",
            repo: "o/r",
            ref: "main",
            queuedAt: "2026-10-09T12:00:00.000Z",
            updatedAt: "2026-10-09T12:00:00.000Z",
          },
          {
            issueId: "i2",
            identifier: "ENG-2",
            status: "published",
            repo: "o/r",
            ref: "main",
            queuedAt: "2026-10-09T12:00:00.000Z",
            updatedAt: "2026-10-09T12:00:00.000Z",
            prUrl: "https://github.com/o/r/pull/1",
          },
        ],
        patch: async () => null,
        command: async () => null,
      },
      d,
    );
    try {
      const t = capture();
      expect(await main(["status", "--dir", d], t.io)).toBe(0);
      expect(t.out).toEqual([
        "ENG-1  awaiting_approval  o/r@main",
        "ENG-2  published  o/r@main  https://github.com/o/r/pull/1",
      ]);
    } finally {
      await server.close();
    }
  });

  it("serve refuses to start while another instance holds the lock", async () => {
    const d = await withConfig();
    await writeFile(join(d, "serve.lock"), String(process.ppid)); // alive, and not us
    const t = capture({ env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(t.err).toEqual([`autoforge serve is already running (pid ${process.ppid}).`]);
    expect(await readFile(join(d, "serve.lock"), "utf8")).toBe(String(process.ppid));
    expect(existsSync(join(d, "state.json"))).toBe(false);
  });

  it("serve replaces a stale lock and removes it on shutdown", async () => {
    const d = await withConfig();
    const dead = spawnSync("true").pid;
    await writeFile(join(d, "serve.lock"), String(dead));
    const stop = new AbortController();
    let lockDuringPoll = "";
    const fetch = (async (_url: string | URL | Request, init: RequestInit = {}) => {
      const { query } = JSON.parse(String(init.body)) as { query: string };
      if (query.includes("viewer")) return gql({ viewer: { id: "u1", name: "Me" } });
      lockDuringPoll = await readFile(join(d, "serve.lock"), "utf8");
      stop.abort();
      return gql({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    }) as typeof globalThis.fetch;
    const t = capture({
      signal: stop.signal,
      fetch,
      env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "g" },
    });
    expect(await main(["serve", "--dir", d], t.io)).toBe(0);
    expect(lockDuringPoll).toBe(String(process.pid));
    expect(existsSync(join(d, "serve.lock"))).toBe(false);
  });

  it("serve releases the lock when the daemon fails to start", async () => {
    const d = await withConfig();
    const fetch = (async () => new Response("nope", { status: 500 })) as typeof globalThis.fetch;
    const t = capture({ fetch, env: { LINEAR_API_KEY: "k", GITHUB_TOKEN: "g" } });
    expect(await main(["serve", "--dir", d], t.io)).toBe(1);
    expect(existsSync(join(d, "serve.lock"))).toBe(false);
  });
});
