export type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
};

export interface SandboxSession {
  /** Absolute path inside the sandbox where the repo is cloned. Must not exist yet, or be empty. */
  readonly workdir: string;
  /** Runs an argv array (never a shell string). Aborting the signal must stop the process. */
  exec(cmd: string[], opts?: ExecOptions): Promise<{ exitCode: number | null }>;
  writeFile(path: string, content: string): Promise<void>;
  destroy(): Promise<void>;
}

export interface Sandbox {
  /** Aborting the signal should stop the creation and clean up anything half made. */
  create(opts?: { signal?: AbortSignal }): Promise<SandboxSession>;
}

/** Throw from create() when the sandbox backend is not running (for example Docker is stopped). */
export class SandboxUnavailableError extends Error {
  override name = "SandboxUnavailableError";
}
