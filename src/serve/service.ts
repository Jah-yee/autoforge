import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { proc, type ProcResult } from "../proc.js";

export type ServiceTarget = {
  /** Absolute path of the node binary (process.execPath). */
  node: string;
  /** Absolute path of dist/serve/cli.js. */
  cli: string;
  home: string;
  /** The installer's PATH, so docker and git resolve under launchd and systemd. */
  path: string;
};

export type Runner = (cmd: string, args: string[]) => Promise<ProcResult>;

export type ServiceOptions = ServiceTarget & {
  platform: NodeJS.Platform;
  uid: number;
  run?: Runner;
};

const LABEL = "dev.autoforge.serve";
const UNIT = "autoforge.service";

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A double-quoted systemd value: backslash and quote escaped, `%` specifiers doubled. */
const quoted = (s: string) => `"${s.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;
/** ExecStart also expands `$VAR`, so `$` is doubled there. */
const execArg = (s: string) => quoted(s).replace(/\$/g, () => "$$");

export function launchdPlist(t: ServiceTarget): string {
  const log = xml(join(t.home, ".autoforge", "daemon.log"));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(t.node)}</string>
    <string>${xml(t.cli)}</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(t.path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

export function systemdUnit(t: ServiceTarget): string {
  return `[Unit]
Description=autoforge serve (Linear issues to pull requests)
After=network-online.target

[Service]
ExecStart=${execArg(t.node)} ${execArg(t.cli)} serve
Environment=${quoted(`PATH=${t.path}`)}
Restart=on-failure
RestartSec=10
StandardOutput=append:%h/.autoforge/daemon.log
StandardError=append:%h/.autoforge/daemon.log

[Install]
WantedBy=default.target
`;
}

export function unitPath(o: { platform: NodeJS.Platform; home: string }): string {
  if (o.platform === "darwin") return join(o.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  if (o.platform === "linux") return join(o.home, ".config", "systemd", "user", UNIT);
  throw new Error(`autoforge service supports macOS and Linux, not ${o.platform}`);
}

const defaultRun: Runner = (cmd, args) => proc(cmd, args, { env: process.env });

async function must(run: Runner, cmd: string, args: string[]): Promise<void> {
  const r = await run(cmd, args);
  if (r.exitCode !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim()}`);
}

/** Writes the unit and starts it. Re-running replaces a previous install. */
export async function installService(o: ServiceOptions): Promise<string> {
  const run = o.run ?? defaultRun;
  const file = unitPath(o);
  await mkdir(dirname(file), { recursive: true });
  // launchd and systemd open daemon.log here but do not create the folder.
  await mkdir(join(o.home, ".autoforge"), { recursive: true, mode: 0o700 });
  if (o.platform === "darwin") {
    await writeFile(file, launchdPlist(o));
    await run("launchctl", ["bootout", `gui/${o.uid}`, file]); // fails when not loaded; fine
    await must(run, "launchctl", ["bootstrap", `gui/${o.uid}`, file]);
  } else {
    await writeFile(file, systemdUnit(o));
    await must(run, "systemctl", ["--user", "daemon-reload"]);
    await must(run, "systemctl", ["--user", "enable", "--now", UNIT]);
  }
  return file;
}

/** Stops the daemon and removes the unit. ~/.autoforge is left alone. */
export async function uninstallService(o: ServiceOptions): Promise<string> {
  const run = o.run ?? defaultRun;
  const file = unitPath(o);
  if (o.platform === "darwin") {
    await run("launchctl", ["bootout", `gui/${o.uid}`, file]);
    await rm(file, { force: true });
  } else {
    await run("systemctl", ["--user", "disable", "--now", UNIT]);
    await rm(file, { force: true });
    await run("systemctl", ["--user", "daemon-reload"]);
  }
  return file;
}
