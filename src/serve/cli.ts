#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DockerSandbox } from "../docker.js";
import { ConfigError, loadConfig, readEnvFile, readSecrets, type Config } from "./config.js";
import { Daemon, type RunSummary } from "./daemon.js";
import { LinearClient } from "./linear.js";
import { lockHeld, releaseLock, takeLock } from "./lock.js";
import { installService, uninstallService } from "./service.js";
import { startStatusServer } from "./status.js";

export type CliIo = {
  out: (line: string) => void;
  err: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Stops `serve`, like SIGINT and SIGTERM do. */
  signal?: AbortSignal;
  /** Used for Linear and for `status`. */
  fetch?: typeof fetch;
};

const USAGE = `Usage:
  autoforge serve [--dir <path>]     run the Linear daemon in the foreground
  autoforge status [--dir <path>]    list the issues the daemon knows about
  autoforge service install          run the daemon at login (launchd or systemd)
  autoforge service uninstall        stop the daemon and remove the service

--dir defaults to ~/.autoforge (config.json, env, state).`;

const parse = (argv: string[]) =>
  parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } },
  });

export async function main(argv: string[], io: CliIo): Promise<number> {
  let args: ReturnType<typeof parse>;
  try {
    args = parse(argv);
  } catch (e) {
    io.err(`${errorMessage(e)}\n\n${USAGE}`);
    return 2;
  }
  if (args.values.help) {
    io.out(USAGE);
    return 0;
  }
  const dir = args.values.dir ?? join(homedir(), ".autoforge");
  const command = args.positionals.join(" ");
  try {
    if (command === "serve") return await serve(dir, io);
    if (command === "status") return await status(dir, io);
    if (command === "service install") return await service(false, io);
    if (command === "service uninstall") return await service(true, io);
  } catch (e) {
    io.err(e instanceof ConfigError ? e.message : `autoforge: ${errorMessage(e)}`);
    return 1;
  }
  io.err(USAGE);
  return 2;
}

async function serve(dir: string, io: CliIo): Promise<number> {
  // The process environment wins over the env file.
  const env = { ...(await readEnvFile(dir)), ...io.env };
  const config = await loadConfig(dir);
  const { linearApiKey } = readSecrets(config, env);
  const lock = join(dir, "serve.lock");
  const holder = await takeLock(lock);
  if (holder) {
    io.err(`autoforge serve is already running (pid ${holder}).`);
    return 1;
  }
  try {
    return await run(dir, io, config, env, linearApiKey, lock);
  } finally {
    await releaseLock(lock);
  }
}

async function run(
  dir: string,
  io: CliIo,
  config: Config,
  env: Record<string, string | undefined>,
  linearApiKey: string,
  lock: string,
): Promise<number> {
  const log = (entry: object) =>
    io.out(JSON.stringify({ time: new Date().toISOString(), ...entry }));
  const daemon = new Daemon({
    config,
    env,
    stateDir: dir,
    linear: new LinearClient({ apiKey: linearApiKey, fetch: io.fetch }),
    sandbox: (agent) => new DockerSandbox({ image: agent.image }),
    log,
  });
  await daemon.start();
  const server = await startStatusServer(daemon, dir);
  const stop = new AbortController();
  const onSignal = () => stop.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  if (io.signal?.aborted) onSignal();
  io.signal?.addEventListener("abort", onSignal, { once: true });
  log({
    level: "info",
    event: "started",
    message: `polling Linear every ${config.pollSeconds} s; status on 127.0.0.1:${server.port}`,
  });
  let code = 0;
  try {
    while (!stop.signal.aborted) {
      await daemon.tick();
      // Backstop for the lock's leftover races: never keep running beside another daemon.
      if (!(await lockHeld(lock))) {
        log({
          level: "error",
          event: "lock_lost",
          message: "lost serve.lock; another instance took over",
        });
        code = 1;
        break;
      }
      await sleep(daemon.nextDelayMs(), undefined, { signal: stop.signal }).catch(() => {});
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    // Close the status server first so no HTTP command lands mid-shutdown.
    await server.close();
    await daemon.stop();
  }
  log({ level: "info", event: "stopped", message: "autoforge serve stopped" });
  return code;
}

async function status(dir: string, io: CliIo): Promise<number> {
  let info: { port: number; token: string };
  try {
    info = JSON.parse(await readFile(join(dir, "status.json"), "utf8")) as typeof info;
  } catch {
    io.err("autoforge serve is not running (no status.json).");
    return 1;
  }
  let runs: RunSummary[];
  try {
    const res = await (io.fetch ?? fetch)(`http://127.0.0.1:${info.port}/runs`, {
      headers: { Authorization: `Bearer ${info.token}` },
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    runs = (await res.json()) as RunSummary[];
  } catch (e) {
    io.err(`autoforge serve is not reachable (stale status.json?): ${errorMessage(e)}`);
    return 1;
  }
  if (!runs.length) io.out("No issues yet.");
  for (const r of runs) {
    io.out([r.identifier, r.status, `${r.repo}@${r.ref}`, r.prUrl ?? ""].join("  ").trimEnd());
  }
  return 0;
}

async function service(uninstall: boolean, io: CliIo): Promise<number> {
  const home = homedir();
  const o = {
    node: process.execPath,
    cli: fileURLToPath(import.meta.url),
    home,
    path: io.env.PATH ?? "/usr/bin:/bin",
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
  };
  if (uninstall) {
    io.out(`Removed ${await uninstallService(o)}. ~/.autoforge was left alone.`);
    return 0;
  }
  io.out(`Installed and started ${await installService(o)}.`);
  io.out(
    `Secrets go in ${join(home, ".autoforge", "env")} (chmod 600). Logs: ${join(home, ".autoforge", "daemon.log")}.`,
  );
  return 0;
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

function isMain(): boolean {
  try {
    return realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = await main(process.argv.slice(2), {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    env: process.env,
  });
}
