import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  installService,
  launchdPlist,
  systemdUnit,
  uninstallService,
  type Runner,
} from "../../src/serve/service.js";

const mac = {
  node: "/opt/node 22/bin/node",
  cli: "/Users/a&b/lib/autoforge/dist/serve/cli.js",
  home: "/Users/a&b",
  path: "/opt/homebrew/bin:/usr/bin:/bin",
};

const linux = {
  node: "/home/u/.nvm/versions/node/v22/bin/node",
  cli: "/home/u/my $apps/50%/cli.js",
  home: "/home/u",
  path: "/home/u/50%/bin:/usr/bin",
};

function recorder(fail?: string) {
  const calls: string[] = [];
  const run: Runner = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    return line.startsWith(fail ?? "\0")
      ? { exitCode: 5, stdout: "", stderr: "Bootstrap failed: 5: Input/output error" }
      : { exitCode: 0, stdout: "", stderr: "" };
  };
  return { calls, run };
}

describe("service units", () => {
  // Review Focus 4
  it("renders a launchd plist with the installer's PATH and escaped paths", () => {
    expect(launchdPlist(mac)).toBe(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.autoforge.serve</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/node 22/bin/node</string>
    <string>/Users/a&amp;b/lib/autoforge/dist/serve/cli.js</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/Users/a&amp;b/.autoforge/daemon.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/a&amp;b/.autoforge/daemon.log</string>
</dict>
</plist>
`);
  });

  // Review Focus 4
  it("renders a systemd user unit with the installer's PATH and escaped paths", () => {
    expect(systemdUnit(linux)).toBe(`[Unit]
Description=autoforge serve (Linear issues to pull requests)
After=network-online.target

[Service]
ExecStart="/home/u/.nvm/versions/node/v22/bin/node" "/home/u/my $$apps/50%%/cli.js" serve
Environment="PATH=/home/u/50%%/bin:/usr/bin"
Restart=on-failure
RestartSec=10
StandardOutput=append:%h/.autoforge/daemon.log
StandardError=append:%h/.autoforge/daemon.log

[Install]
WantedBy=default.target
`);
  });
});

describe("escaping", () => {
  const nasty = { ...mac, node: '/a<b>"c\\d/node', cli: "/x/cli.js", home: "/h" };

  it("escapes <, >, quote and backslash in the plist", () => {
    expect(launchdPlist(nasty)).toContain("<string>/a&lt;b&gt;&quot;c\\d/node</string>");
  });

  it("escapes backslash and quote in the systemd unit", () => {
    expect(systemdUnit(nasty)).toContain('ExecStart="/a<b>\\"c\\\\d/node" "/x/cli.js" serve');
  });
});

describe("installService", () => {
  it("installs on macOS: writes the plist, boots out any old copy, bootstraps", async () => {
    const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
    const { calls, run } = recorder("launchctl bootout");
    const file = await installService({ ...mac, home, platform: "darwin", uid: 501, run });
    expect(file).toBe(join(home, "Library", "LaunchAgents", "dev.autoforge.serve.plist"));
    expect(await readFile(file, "utf8")).toBe(launchdPlist({ ...mac, home }));
    expect(calls).toEqual([
      `launchctl bootout gui/501 ${file}`,
      `launchctl bootstrap gui/501 ${file}`,
    ]);
    expect((await stat(join(home, ".autoforge"))).isDirectory()).toBe(true);
  });

  it("fails with launchctl's message when bootstrap fails", async () => {
    const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
    const { run } = recorder("launchctl bootstrap");
    await expect(
      installService({ ...mac, home, platform: "darwin", uid: 501, run }),
    ).rejects.toThrow("Bootstrap failed: 5: Input/output error");
  });

  it("installs on Linux with systemctl --user", async () => {
    const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
    const { calls, run } = recorder();
    const file = await installService({ ...linux, home, platform: "linux", uid: 1000, run });
    expect(file).toBe(join(home, ".config", "systemd", "user", "autoforge.service"));
    expect(await readFile(file, "utf8")).toBe(systemdUnit({ ...linux, home }));
    expect(calls).toEqual([
      "systemctl --user daemon-reload",
      "systemctl --user enable --now autoforge.service",
      "systemctl --user restart autoforge.service",
    ]);
  });

  it.each(["darwin", "linux"] as const)(
    "uninstalls on %s without touching ~/.autoforge data",
    async (platform) => {
      const home = await mkdtemp(join(tmpdir(), "autoforge-home-"));
      await mkdir(join(home, ".autoforge"));
      await writeFile(join(home, ".autoforge", "state.json"), "{}");
      const { calls, run } = recorder();
      const o = { ...linux, home, platform, uid: 1000, run };
      const file = await installService(o);
      expect(await uninstallService(o)).toBe(file);
      expect(existsSync(file)).toBe(false);
      expect(await readFile(join(home, ".autoforge", "state.json"), "utf8")).toBe("{}");
      expect(calls.at(-1)).toBe(
        platform === "darwin"
          ? `launchctl bootout gui/1000 ${file}`
          : "systemctl --user daemon-reload",
      );
    },
  );

  it("refuses other platforms", async () => {
    const { run } = recorder();
    await expect(installService({ ...linux, platform: "win32", uid: 0, run })).rejects.toThrow(
      "autoforge service supports macOS and Linux, not win32",
    );
  });
});
