import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { proc } from "../src/proc.js";
import type { ExecOptions, Sandbox, SandboxSession } from "../src/sandbox.js";

/** Test-only: runs commands on the host in a temp folder. Not isolated. Never export from src. */
export class TempDirSandbox implements Sandbox {
  destroyed = 0;

  async create(): Promise<SandboxSession> {
    const root = await mkdtemp(join(tmpdir(), "autoforge-test-"));
    const base = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root };
    return {
      workdir: join(root, "workspace"),
      exec: async (cmd: string[], o: ExecOptions = {}) => {
        const [bin = "", ...args] = cmd;
        const r = await proc(bin, args, {
          cwd: o.cwd ?? root,
          env: { ...base, ...o.env },
          signal: o.signal,
          onStdout: o.onStdout ?? (() => {}),
          onStderr: o.onStderr ?? (() => {}),
          killGroup: true,
        });
        return { exitCode: r.exitCode };
      },
      writeFile: async (path: string, content: string) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content);
      },
      destroy: async () => {
        this.destroyed++;
        await rm(root, { recursive: true, force: true });
      },
    };
  }
}
