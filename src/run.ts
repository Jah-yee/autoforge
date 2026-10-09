import { randomUUID } from "node:crypto";
import { LineSplitter, TailBuffer } from "./logs.js";
import { makeRedactor } from "./redact.js";
import {
  SandboxUnavailableError,
  type ExecOptions,
  type Sandbox,
  type SandboxSession,
} from "./sandbox.js";

export type RunStatus = "changed" | "no_changes" | "failed" | "timed_out";
export type FailureReason =
  "aborted" | "clone_failed" | "sandbox_unavailable" | "sandbox_error" | "patch_too_large";
export type Phase = "creating_sandbox" | "cloning" | "running" | "collecting" | "done";
export type RunEvent =
  { type: "phase"; phase: Phase } | { type: "log"; stream: "stdout" | "stderr"; line: string };

export type RunOptions = {
  repo: { url: string; ref: string; token?: string };
  task: string;
  agent: { command: string[]; env?: Record<string, string> };
  sandbox: Sandbox;
  timeoutMs?: number;
  maxLogBytes?: number;
  maxPatchBytes?: number;
  signal?: AbortSignal;
  onEvent?: (event: RunEvent) => void;
};

export type RunResult = {
  id: string;
  status: RunStatus;
  reason?: FailureReason;
  message?: string;
  repo: { url: string; ref: string };
  task: string;
  baseSha?: string;
  patch: string;
  filesChanged: string[];
  logs: string;
  exitCode: number | null;
  startedAt: string;
  durationMs: number;
};

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0" };

export async function run(options: RunOptions): Promise<RunResult> {
  validate(options);
  const { repo, task, agent, sandbox } = options;
  const maxPatchBytes = options.maxPatchBytes ?? 10_000_000;
  const emit = options.onEvent ?? (() => {});

  // The token reaches git as a one-off header on the clone command, never as config on disk.
  const authHeader = repo.token
    ? `Authorization: Basic ${Buffer.from(`x-access-token:${repo.token}`).toString("base64")}`
    : undefined;
  const redact = makeRedactor([...Object.values(agent.env ?? {}), repo.token, authHeader]);
  const logs = new TailBuffer(options.maxLogBytes ?? 1_000_000);
  const logLine = (stream: "stdout" | "stderr") => (raw: string) => {
    const line = redact(raw);
    logs.push(line);
    emit({ type: "log", stream, line });
  };
  const stdout = new LineSplitter(logLine("stdout"));
  const stderr = new LineSplitter(logLine("stderr"));

  const timeout = AbortSignal.timeout(options.timeoutMs ?? 30 * 60_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;

  const started = Date.now();
  const result: RunResult = {
    id: randomUUID(),
    status: "failed",
    repo: { url: repo.url, ref: repo.ref },
    task,
    patch: "",
    filesChanged: [],
    logs: "",
    exitCode: null,
    startedAt: new Date(started).toISOString(),
    durationMs: 0,
  };
  const finish = (fields: Partial<RunResult>): RunResult => {
    emit({ type: "phase", phase: "done" });
    return Object.assign(result, fields, {
      logs: logs.toString(),
      durationMs: Date.now() - started,
    });
  };
  const fail = (reason: FailureReason, message: string) =>
    finish({ status: "failed", reason, message: redact(message) });
  const stopped = () =>
    options.signal?.aborted
      ? fail("aborted", "the run was aborted")
      : finish({ status: "timed_out", message: "the run hit its timeout" });

  const inSession = async (s: SandboxSession): Promise<RunResult> => {
    const w = s.workdir;
    const exec = async (cmd: string[], opts: ExecOptions) => {
      try {
        return await s.exec(cmd, {
          onStdout: (c) => stdout.push(c),
          onStderr: (c) => stderr.push(c),
          ...opts,
        });
      } finally {
        stdout.flush();
        stderr.flush();
      }
    };
    // Collects stdout instead of logging it, up to `limit` bytes.
    const capture = async (cmd: string[], limit = Infinity) => {
      let text = "";
      let bytes = 0;
      const r = await exec(cmd, {
        cwd: w,
        env: GIT_ENV,
        onStdout: (c) => {
          bytes += Buffer.byteLength(c);
          if (bytes <= limit) text += c;
        },
      });
      return { ok: r.exitCode === 0, text, overflow: bytes > limit };
    };

    emit({ type: "phase", phase: "cloning" });
    // Via env, not argv: with Docker the argv is visible in the host's process list.
    const auth: Record<string, string> = authHeader
      ? {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: "http.extraHeader",
          GIT_CONFIG_VALUE_0: authHeader,
        }
      : {};
    const clone = await exec(["git", "clone", "--quiet", "--", repo.url, w], {
      env: { ...GIT_ENV, ...auth },
      signal,
    });
    if (signal.aborted) return stopped();
    if (clone.exitCode !== 0)
      return fail("clone_failed", `git clone exited with code ${clone.exitCode}`);

    let baseSha = "";
    for (const rev of [`origin/${repo.ref}^{commit}`, `${repo.ref}^{commit}`]) {
      const r = await capture(["git", "rev-parse", "--verify", "--quiet", rev]);
      if (r.ok) {
        baseSha = r.text.trim();
        break;
      }
    }
    if (!baseSha) return fail("clone_failed", `ref not found: ${repo.ref}`);
    const checkout = await exec(["git", "checkout", "--quiet", "--detach", baseSha], {
      cwd: w,
      env: GIT_ENV,
    });
    if (checkout.exitCode !== 0) return fail("clone_failed", `could not check out ${repo.ref}`);
    result.baseSha = baseSha;

    const taskFile = `${w}/.autoforge/task.md`;
    await s.writeFile(taskFile, task);
    // The default exclude file only holds comments, so overwriting it is safe.
    await s.writeFile(`${w}/.git/info/exclude`, ".autoforge/\n");

    emit({ type: "phase", phase: "running" });
    const command = agent.command.map((arg) => arg.replaceAll("{task}", () => task));
    const agentRun = await exec(command, {
      cwd: w,
      env: { ...agent.env, AUTOFORGE_TASK: task, AUTOFORGE_TASK_FILE: taskFile },
      signal,
    });
    result.exitCode = agentRun.exitCode;
    if (options.signal?.aborted) return stopped();

    emit({ type: "phase", phase: "collecting" });
    const add = await capture(["git", "add", "-A"]);
    const diff = await capture(["git", "diff", "--cached", "--binary", baseSha], maxPatchBytes);
    if (!add.ok || !diff.ok)
      return fail("sandbox_error", "could not collect the agent's changes with git");
    if (diff.overflow)
      return fail("patch_too_large", `the patch is larger than ${maxPatchBytes} bytes`);
    const names = await capture(["git", "diff", "--cached", "--name-only", baseSha]);
    const status: RunStatus = timeout.aborted ? "timed_out" : diff.text ? "changed" : "no_changes";
    return finish({
      status,
      patch: diff.text,
      filesChanged: names.text.split("\n").filter(Boolean),
    });
  };

  emit({ type: "phase", phase: "creating_sandbox" });
  let session: SandboxSession;
  try {
    session = await sandbox.create();
  } catch (e) {
    const reason = e instanceof SandboxUnavailableError ? "sandbox_unavailable" : "sandbox_error";
    return fail(reason, errorMessage(e));
  }
  try {
    return await inSession(session);
  } catch (e) {
    return fail("sandbox_error", errorMessage(e));
  } finally {
    await session.destroy().catch(() => {});
  }
}

function validate(o: RunOptions): void {
  if (typeof o.task !== "string" || !o.task.trim())
    throw new TypeError("task must be a non-empty string");
  if (!o.repo?.url || !o.repo.ref) throw new TypeError("repo.url and repo.ref are required");
  if (o.repo.url.startsWith("-") || o.repo.ref.startsWith("-")) {
    throw new TypeError("repo.url and repo.ref must not start with '-'");
  }
  if (!o.agent?.command?.length) throw new TypeError("agent.command needs at least one entry");
  if (!o.sandbox) throw new TypeError("sandbox is required");
  for (const key of ["timeoutMs", "maxLogBytes", "maxPatchBytes"] as const) {
    const v = o[key];
    if (v !== undefined && !(v > 0)) throw new TypeError(`${key} must be a positive number`);
  }
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
