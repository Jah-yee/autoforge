import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeAgent } from "./fake-agent.js";
import { git, makeBareRepo } from "./helpers.js";
import { TempDirSandbox } from "./temp-dir-sandbox.js";

describe("TempDirSandbox", () => {
  it("runs commands with only the env it is given", async () => {
    const sb = new TempDirSandbox();
    const s = await sb.create();
    let out = "";
    const r = await s.exec(["sh", "-c", 'echo "[$GIT_DIR][$FOO]"'], {
      env: { FOO: "bar" },
      onStdout: (c) => (out += c),
    });
    expect(r.exitCode).toBe(0);
    expect(out.trim()).toBe("[][bar]");
    await s.destroy();
  });

  it("writes files, creating folders, and removes everything on destroy", async () => {
    const sb = new TempDirSandbox();
    const s = await sb.create();
    expect(existsSync(s.workdir)).toBe(false);
    await s.writeFile(join(s.workdir, "a/b.txt"), "hi");
    expect(existsSync(join(s.workdir, "a/b.txt"))).toBe(true);
    await s.destroy();
    expect(existsSync(s.workdir)).toBe(false);
    expect(sb.destroyed).toBe(1);
  });
});

describe("makeBareRepo", () => {
  it("has main and feature branches", async () => {
    const r = await makeBareRepo();
    expect(await git(r.bare, "rev-parse", "main")).toBe(r.mainSha);
    expect(await git(r.bare, "rev-parse", "feature")).toBe(r.featureSha);
  });
});

describe("fakeAgent", () => {
  it("builds an sh -c argv", () => {
    expect(fakeAgent("argv", "{task}").slice(3)).toEqual(["fake", "argv", "{task}"]);
  });
});
