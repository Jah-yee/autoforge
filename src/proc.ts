import { spawn } from "node:child_process";

export type ProcOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Spawn detached and kill the whole process group on abort. */
  killGroup?: boolean;
};

export type ProcResult = { exitCode: number | null; stdout: string; stderr: string };

/**
 * Runs a command without a shell. Never rejects: a command that cannot start returns 127.
 * Output goes to the callbacks when given, otherwise it is collected into the result.
 */
export function proc(cmd: string, args: string[], o: ProcOptions = {}): Promise<ProcResult> {
  return new Promise((resolve) => {
    if (o.signal?.aborted) return resolve({ exitCode: null, stdout: "", stderr: "" });
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      detached: o.killGroup,
      stdio: [o.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (c: string) => {
      if (o.onStdout) o.onStdout(c);
      else stdout += c;
    });
    child.stderr?.setEncoding("utf8").on("data", (c: string) => {
      if (o.onStderr) o.onStderr(c);
      else stderr += c;
    });
    if (child.stdin) {
      child.stdin.on("error", () => {}); // the child may exit before reading everything
      child.stdin.end(o.input);
    }
    const onAbort = () => {
      try {
        if (o.killGroup && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // already exited
      }
    };
    o.signal?.addEventListener("abort", onAbort, { once: true });
    const done = (exitCode: number | null) => {
      o.signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr });
    };
    child.on("error", (err) => {
      if (o.onStderr) o.onStderr(String(err));
      else stderr += String(err);
      done(127);
    });
    child.on("close", (code) => done(code));
  });
}
