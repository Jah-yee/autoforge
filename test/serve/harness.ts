import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/serve/config.js";
import { Daemon, type DaemonOptions, type LogEntry } from "../../src/serve/daemon.js";
import type { LinearUser } from "../../src/serve/linear.js";
import type { State } from "../../src/serve/state.js";
import { fakeAgent } from "../fake-agent.js";
import { makeBareRepo } from "../helpers.js";
import { TempDirSandbox } from "../temp-dir-sandbox.js";
import { FakeLinear, ME } from "./fake-linear.js";

export const ENV = { LINEAR_API_KEY: "lin_api_secret_0001", GITHUB_TOKEN: "ghp_secret_0002" };

export type GitHubStub = {
  /** HTTP status the next pull request call returns. */
  status: number;
  pulls: { url: string; body: Record<string, unknown> }[];
  fetch: typeof fetch;
};

export function stubGitHub(): GitHubStub {
  const gh: GitHubStub = {
    status: 201,
    pulls: [],
    fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
      gh.pulls.push({
        url: String(url),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      const ok = gh.status < 300;
      const body = ok
        ? { html_url: `https://github.com/o/r/pull/${gh.pulls.length}` }
        : { message: "nope" };
      return new Response(JSON.stringify(body), { status: gh.status });
    }) as typeof globalThis.fetch,
  };
  return gh;
}

/** A daemon world: fake Linear, a frozen clock, a local bare repo and a temp state dir. */
export async function setup(o: { config?: Record<string, unknown>; agent?: string[] } = {}) {
  let t = Date.parse("2026-10-09T12:00:00.000Z");
  const clock = {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
  const linear = new FakeLinear(clock.now);
  const repo = await makeBareRepo();
  const dir = await mkdtemp(join(tmpdir(), "autoforge-serve-"));
  const github = stubGitHub();
  const logs: LogEntry[] = [];
  const config = parseConfig({
    defaultRepo: "o/r@main",
    agent: { image: "unused", command: o.agent ?? fakeAgent("edit") },
    ...o.config,
  });
  const sandbox = new TempDirSandbox();
  const make = (extra: Partial<DaemonOptions> = {}) =>
    new Daemon({
      config,
      linear,
      stateDir: dir,
      env: ENV,
      sandbox: () => sandbox,
      now: clock.now,
      repoUrl: () => repo.bare,
      github: { apiUrl: "https://api.example.test", fetch: github.fetch },
      log: (e) => logs.push(e),
      ...extra,
    });
  /** The user (or someone else) comments one second later. */
  const reply = (issueId: string, body: string, user: LinearUser = ME) => {
    clock.advance(1000);
    return linear.userComment(issueId, body, user);
  };
  return { clock, linear, repo, dir, github, logs, config, make, reply };
}

/** One poll, then wait for every run and publish it started. */
export async function step(d: Daemon): Promise<void> {
  await d.tick();
  await d.idle();
}

export async function readState(dir: string): Promise<State> {
  return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as State;
}
