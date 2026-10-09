import { randomUUID } from "node:crypto";
import { proc } from "./proc.js";
import {
  SandboxUnavailableError,
  type ExecOptions,
  type Sandbox,
  type SandboxSession,
} from "./sandbox.js";

export type DockerSandboxOptions = {
  /** Image to run. Must contain git and sh. */
  image: string;
  cpus?: number;
  memory?: string;
  network?: "bridge" | "none";
  /** uid:gid inside the container. Defaults to a non-root user. */
  user?: string;
};

const WORKDIR = "/workspace";

/** One container per session, driven through the docker CLI. No host folders are mounted. */
export class DockerSandbox implements Sandbox {
  constructor(private readonly options: DockerSandboxOptions) {}

  async create({ signal }: { signal?: AbortSignal } = {}): Promise<SandboxSession> {
    const { image, cpus = 2, memory = "4g", network = "bridge", user = "1000:1000" } = this.options;
    const aborted = () => new Error("sandbox creation was aborted");
    const info = await proc("docker", ["info", "--format", "{{.ServerVersion}}"], { signal });
    if (signal?.aborted) throw aborted();
    if (info.exitCode !== 0) {
      throw new SandboxUnavailableError(
        "Docker is not running. Start Docker Desktop, OrbStack or Colima and try again.",
      );
    }
    // A known name, so an aborted `docker run` (which may still create the container) can be
    // removed even though it never printed an id.
    const name = `autoforge-${randomUUID()}`;
    const destroy = async () => {
      await proc("docker", ["rm", "-f", name]);
    };
    const started = await proc(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        name,
        "--label",
        "autoforge=1",
        "--cpus",
        String(cpus),
        "--memory",
        memory,
        "--pids-limit",
        "4096",
        "--network",
        network,
        "--user",
        user,
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        // Only for the root prep step below, which chowns the workdir. The agent runs as `user`
        // with no effective capabilities, and no-new-privileges stops it gaining this one.
        "--cap-add",
        "CHOWN",
        "-e",
        "HOME=/tmp",
        "--entrypoint",
        "sleep",
        image,
        "infinity",
      ],
      { signal },
    );
    if (signal?.aborted) {
      await destroy();
      throw aborted();
    }
    if (started.exitCode !== 0) throw new Error(`docker run failed: ${started.stderr.trim()}`);
    const id = started.stdout.trim();

    const prep = await proc("docker", [
      "exec",
      "-u",
      "0",
      id,
      "sh",
      "-c",
      'mkdir -p "$1" && chown "$2" "$1"',
      "sh",
      WORKDIR,
      user,
    ]);
    if (prep.exitCode !== 0 || signal?.aborted) {
      await destroy();
      if (signal?.aborted) throw aborted();
      throw new Error(`could not prepare ${WORKDIR}: ${prep.stderr.trim()}`);
    }

    return {
      workdir: WORKDIR,
      async exec(cmd: string[], o: ExecOptions = {}) {
        const env = o.env ?? {};
        const r = await proc(
          "docker",
          [
            "exec",
            "-u",
            user,
            ...(o.cwd ? ["-w", o.cwd] : []),
            ...Object.keys(env).flatMap((k) => ["-e", k]),
            id,
            ...cmd,
          ],
          {
            // `-e NAME` makes docker read the value from its own env, so secrets never show in `ps`.
            env: { ...process.env, ...env },
            signal: o.signal,
            onStdout: o.onStdout ?? (() => {}),
            onStderr: o.onStderr ?? (() => {}),
          },
        );
        // Killing the docker client leaves the process running in the container. PID 1 (sleep)
        // ignores SIGKILL from inside its namespace, so this stops everything else.
        if (o.signal?.aborted) {
          await proc("docker", [
            "exec",
            "-u",
            user,
            id,
            "sh",
            "-c",
            "kill -9 -1 2>/dev/null; true",
          ]);
        }
        return { exitCode: r.exitCode };
      },
      async writeFile(path: string, content: string) {
        const r = await proc(
          "docker",
          [
            "exec",
            "-i",
            "-u",
            user,
            id,
            "sh",
            "-c",
            'mkdir -p "$(dirname "$1")" && cat > "$1"',
            "sh",
            path,
          ],
          { input: content },
        );
        if (r.exitCode !== 0) throw new Error(`writeFile ${path} failed: ${r.stderr.trim()}`);
      },
      destroy,
    };
  }
}
