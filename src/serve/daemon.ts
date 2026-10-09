import { mkdir } from "node:fs/promises";
import { publishToGitHub, PublishError } from "../github.js";
import { makeRedactor } from "../redact.js";
import { run, type RunResult } from "../run.js";
import type { Sandbox } from "../sandbox.js";
import { readSecrets, type AgentConfig, type Config, type Secrets } from "./config.js";
import { LinearError, type LinearApi, type LinearIssue } from "./linear.js";
import { MARKER, parseCommand, renderTask, type Command } from "./prompt.js";
import { routeIssue } from "./route.js";
import {
  deletePatch,
  loadState,
  readPatch,
  saveState,
  writePatch,
  type IssueEntry,
  type IssueStatus,
  type State,
} from "./state.js";

export type LogEntry = {
  level: "info" | "warn" | "error";
  event: string;
  message: string;
  issue?: string;
};

export type DaemonOptions = {
  config: Config;
  linear: LinearApi;
  /** Holds state.json, patches/ and status.json. */
  stateDir: string;
  /** LINEAR_API_KEY, GITHUB_TOKEN, CLONE_TOKEN and the agent envFrom names are read from here. */
  env: Record<string, string | undefined>;
  /** Builds the sandbox for one run, for example a DockerSandbox for agent.image. */
  sandbox: (agent: AgentConfig) => Sandbox;
  now?: () => Date;
  /** Clone and push URL for "owner/name". Defaults to https://github.com/<repo>.git */
  repoUrl?: (repo: string) => string;
  /** Passed through to publishToGitHub. */
  github?: { apiUrl?: string; fetch?: typeof fetch };
  /** One call per log line. Defaults to a JSON line on stdout. */
  log?: (entry: LogEntry) => void;
};

type Job = { abort: AbortController; dropped: boolean; done: Promise<void> };

const DAY = 86_400_000;
const ACTIVE: IssueStatus[] = ["queued", "running", "awaiting_approval", "publishing"];
const RETRYABLE: IssueStatus[] = ["awaiting_approval", "no_changes", "failed", "timed_out"];
const RETRY_HINT = "Reply `/retry <feedback>` to run it again with your feedback.";
const CHECK_GITHUB_HINT =
  "Check GitHub for an existing branch or pull request first; reply `/publish force` to push again.";
const SECRET_WARNING = "Warning: this patch contains one of your secrets and cannot be published.";
const PUBLISH_TIMEOUT_MS = 300_000;

export type CommandOutcome = { ok: boolean; message: string };

export type RunSummary = {
  issueId: string;
  identifier: string;
  status: IssueStatus;
  repo: string;
  ref: string;
  queuedAt: string;
  updatedAt: string;
  prUrl?: string;
};

const VALID_WHEN: Record<Command["kind"], string> = {
  publish: "while a result is waiting for approval",
  discard: "while a result is waiting for approval",
  retry: "after a run, before it is published or discarded",
};

export class Daemon {
  private state!: State;
  private readonly secrets: Secrets;
  private readonly mask: (text: string) => string;
  private readonly now: () => Date;
  private readonly repoUrl: (repo: string) => string;
  private readonly jobs = new Map<string, Job>();
  private readonly publishes = new Set<Promise<void>>();
  /** The latest copy of each issue seen by a poll. */
  private readonly latest = new Map<string, LinearIssue>();
  private readonly stopping = new AbortController();
  private saving: Promise<void> = Promise.resolve();
  private sending: Promise<void> = Promise.resolve();
  private failures = 0;
  private retryAfterMs: number | undefined;
  private dockerDown = false;

  constructor(private readonly o: DaemonOptions) {
    this.secrets = readSecrets(o.config, o.env);
    this.mask = makeRedactor([
      this.secrets.linearApiKey,
      this.secrets.githubToken,
      this.secrets.cloneToken,
      ...Object.values(this.secrets.agentEnv),
    ]);
    this.now = o.now ?? (() => new Date());
    this.repoUrl = o.repoUrl ?? ((repo) => `https://github.com/${repo}.git`);
  }

  async start(): Promise<void> {
    await mkdir(this.o.stateDir, { recursive: true, mode: 0o700 });
    const { state, corruptPath } = await loadState(this.o.stateDir, this.now());
    this.state = state;
    if (corruptPath) {
      this.log(
        "error",
        "state_corrupt",
        `state.json was unreadable; moved it to ${corruptPath} and started fresh`,
      );
    }
    this.state.viewerId = (await this.o.linear.viewer()).id;
    await this.recover();
    await this.save();
  }

  /** How long to wait before the next tick: the poll interval, or the backoff after errors. */
  nextDelayMs(): number {
    if (!this.failures) return this.o.config.pollSeconds * 1000;
    const backoff = Math.min(5000 * 2 ** (this.failures - 1), 300_000);
    return Math.max(backoff, this.retryAfterMs ?? 0);
  }

  /** One poll: post pending comments, read Linear, handle each issue, start runs. Never throws. */
  async tick(): Promise<void> {
    try {
      await this.flushOutbox();
      const tracked = Object.entries(this.state.issues)
        .filter(([, e]) => this.tracked(e))
        .map(([id]) => id);
      let issues: LinearIssue[];
      try {
        issues = await this.o.linear.changedIssues(this.state.cursor, tracked);
      } catch (e) {
        this.failures++;
        this.retryAfterMs = e instanceof LinearError ? e.retryAfterMs : undefined;
        this.log(
          "warn",
          "poll_failed",
          `${errorMessage(e)}; next try in ${this.nextDelayMs() / 1000} s`,
        );
        return;
      }
      this.failures = 0;
      this.retryAfterMs = undefined;
      let cursor = this.state.cursor;
      for (const issue of issues) {
        this.latest.set(issue.id, issue);
        await this.handleIssue(issue);
        if (Date.parse(issue.updatedAt) > Date.parse(cursor)) cursor = issue.updatedAt;
      }
      this.state.cursor = cursor;
      await this.expire();
      await this.schedule();
    } catch (e) {
      this.log("error", "tick_failed", errorMessage(e));
    } finally {
      await this.save();
    }
  }

  /** Resolves once no run or publish is in flight. */
  async idle(): Promise<void> {
    while (this.jobs.size || this.publishes.size) {
      await Promise.all([...[...this.jobs.values()].map((j) => j.done), ...this.publishes]);
    }
    await this.sending;
    await this.saving;
  }

  /** Aborts runs in flight and leaves them "running" in state, so the next start re-queues them. */
  async stop(): Promise<void> {
    this.stopping.abort();
    await this.idle();
    await this.save();
  }

  /** Issues in state, for the status endpoint. No patches, no logs. */
  runs(): RunSummary[] {
    return Object.entries(this.state.issues).map(([issueId, e]) => ({
      issueId,
      identifier: e.identifier,
      status: e.status,
      repo: e.repo,
      ref: e.ref,
      queuedAt: e.queuedAt,
      updatedAt: e.updatedAt,
      ...(e.prUrl ? { prUrl: e.prUrl } : {}),
    }));
  }

  async patch(issueId: string): Promise<string | null> {
    const run = this.entryOf(issueId)?.run;
    return run ? readPatch(this.o.stateDir, run.id) : null;
  }

  /** A command from the status endpoint: the same checks as a Linear comment, no reply on a wrong state. */
  async command(issueId: string, command: Command): Promise<CommandOutcome | null> {
    return this.apply(issueId, command, false);
  }

  private tracked(e: IssueEntry): boolean {
    if (ACTIVE.includes(e.status)) return true;
    // ponytail: finished runs stay tracked for approvalExpiryDays so a late /retry is seen;
    // after that only an edit to the issue brings them back into a poll.
    return RETRYABLE.includes(e.status) && this.age(e) < this.o.config.approvalExpiryDays * DAY;
  }

  private age(e: IssueEntry): number {
    return this.now().getTime() - Date.parse(e.updatedAt);
  }

  private async handleIssue(issue: LinearIssue): Promise<void> {
    const { pickup, label } = this.o.config;
    const entry = this.state.issues[issue.id];
    const picked =
      issue.assigneeId === this.state.viewerId &&
      (pickup === "all-assigned" ||
        issue.labels.some((l) => l.toLowerCase() === label.toLowerCase()));
    const open = issue.stateType !== "completed" && issue.stateType !== "canceled";
    if (entry && picked && open) return this.handleComments(issue, entry);
    if (entry) return this.release(issue.id, entry, picked);
    if (picked && open) await this.pickUp(issue);
  }

  private async pickUp(issue: LinearIssue): Promise<void> {
    const route = routeIssue(issue, this.o.config);
    if (!route) {
      const labels = issue.labels.toSorted().join("\n");
      if (this.state.noRoute[issue.id] === labels) return;
      this.state.noRoute[issue.id] = labels;
      await this.post(
        issue.id,
        "No repo configured for this issue. Add a `repo:owner/name` label or a rule in config.",
      );
      return;
    }
    delete this.state.noRoute[issue.id];
    const now = this.now().toISOString();
    this.state.issues[issue.id] = {
      identifier: issue.identifier,
      status: "queued",
      repo: route.repo,
      ref: route.ref,
      interruptions: 0,
      // Commands written before pickup never fire.
      handledCommentIds: issue.comments.map((c) => c.id),
      queuedAt: now,
      updatedAt: now,
    };
    this.log("info", "queued", `queued for ${route.repo}@${route.ref}`, issue.identifier);
    await this.post(issue.id, `Queued for autoforge (position ${this.position(issue.id)}).`, true);
  }

  /** After a restart: re-queue an interrupted run once, and hand an interrupted publish back. */
  private async recover(): Promise<void> {
    for (const [id, e] of Object.entries(this.state.issues)) {
      if (e.status === "running" && e.interruptions >= 1) {
        this.set(e, { status: "failed" });
        await this.post(
          id,
          `autoforge was interrupted twice while running this issue and stopped trying.\n\n${RETRY_HINT}`,
          true,
        );
      } else if (e.status === "running") {
        this.set(e, { status: "queued", interruptions: e.interruptions + 1 });
        await this.post(id, "autoforge restarted during the run, so the issue is queued again.");
      } else if (e.status === "publishing") {
        this.set(e, { status: "awaiting_approval" });
        await this.post(
          id,
          `autoforge restarted while publishing, so the pull request may or may not have been opened. ${CHECK_GITHUB_HINT}`,
        );
      }
    }
  }

  /** The issue no longer matches pickup (unassigned, label removed) or was closed. */
  private async release(id: string, entry: IssueEntry, picked: boolean): Promise<void> {
    const why = "the issue was unassigned, lost its pickup label or was closed";
    if (entry.status === "queued") {
      delete this.state.issues[id];
      await this.post(id, `Removed from the autoforge queue: ${why}.`);
    } else if (entry.status === "running") {
      const job = this.jobs.get(id);
      if (job) {
        job.dropped = true;
        job.abort.abort();
      }
      delete this.state.issues[id];
      await this.post(id, `autoforge stopped the run: ${why}.`);
    } else if (!picked && entry.status !== "publishing") {
      // Forgetting the entry is what lets "remove the label, add it again" start over.
      delete this.state.issues[id];
      await this.save();
      if (entry.run) await this.dropPatch(entry.run.id, entry.identifier);
    }
  }

  private async expire(): Promise<void> {
    const days = this.o.config.approvalExpiryDays;
    for (const [id, e] of Object.entries(this.state.issues)) {
      if (e.status !== "awaiting_approval" || this.age(e) <= days * DAY) continue;
      this.set(e, { status: "discarded" });
      await this.save();
      if (e.run) await this.dropPatch(e.run.id, e.identifier);
      await this.post(id, `Discarded: no reply within ${days} days.`);
    }
  }

  /** The state already says the patch is unneeded, so a failed delete is only logged. */
  private async dropPatch(runId: string, identifier: string): Promise<void> {
    try {
      await deletePatch(this.o.stateDir, runId);
    } catch (e) {
      this.log("warn", "cleanup_failed", errorMessage(e), identifier);
    }
  }

  /** Queued entries, oldest first. */
  private queue(): [string, IssueEntry][] {
    return Object.entries(this.state.issues)
      .filter(([, e]) => e.status === "queued")
      .sort(([, a], [, b]) => a.queuedAt.localeCompare(b.queuedAt));
  }

  private position(issueId: string): number {
    return this.queue().findIndex(([id]) => id === issueId) + 1;
  }

  private async schedule(): Promise<void> {
    const { maxConcurrent, dailyRunLimit } = this.o.config;
    const today = localDate(this.now());
    if (this.state.dailyRuns.date !== today) {
      this.state.dailyRuns = { date: today, count: 0 };
      // A new day: a still-limited issue gets a fresh comment.
      for (const e of Object.values(this.state.issues))
        if (e.waiting === "limit") e.waiting = undefined;
    }
    for (const [id, e] of this.queue()) {
      if (this.jobs.has(id)) continue; // an aborted run for this issue is still winding down
      // While Docker is down, a single run at a time probes it.
      if (this.jobs.size >= maxConcurrent || (this.dockerDown && this.jobs.size > 0)) return;
      if (this.state.dailyRuns.count >= dailyRunLimit) {
        if (e.waiting !== "limit") {
          e.waiting = "limit";
          await this.post(
            id,
            `The daily run limit (${dailyRunLimit}) is reached. This issue stays queued and starts tomorrow.`,
          );
        }
        continue;
      }
      this.startRun(id, e);
    }
  }

  private startRun(id: string, entry: IssueEntry): void {
    const issue = this.latest.get(id);
    if (!issue) return;
    const { config } = this.o;
    // Labels may have changed while queued, so route again.
    const route = routeIssue(issue, config) ?? {
      repo: entry.repo,
      ref: entry.ref,
      agent: config.agent,
    };
    this.set(entry, { status: "running", repo: route.repo, ref: route.ref });
    this.state.dailyRuns.count++;
    const task = renderTask(issue, {
      template: config.template,
      comments: config.comments,
      viewerId: this.state.viewerId,
      feedback: entry.feedback,
    });
    const abort = new AbortController();
    const job: Job = { abort, dropped: false, done: Promise.resolve() };
    let announced: Promise<void> | undefined;
    job.done = (async () => {
      let result: RunResult | Error;
      try {
        result = await run({
          repo: { url: this.repoUrl(route.repo), ref: route.ref, token: this.secrets.cloneToken },
          task,
          agent: {
            command: route.agent.command,
            env: pick(this.secrets.agentEnv, route.agent.envFrom),
          },
          sandbox: this.o.sandbox(route.agent),
          timeoutMs: route.agent.timeoutMinutes * 60_000,
          signal: AbortSignal.any([abort.signal, this.stopping.signal]),
          onEvent: (ev) => {
            if (ev.type === "log") this.log("info", "agent", ev.line, entry.identifier);
            else if (ev.phase === "cloning")
              announced ??= this.announce(id, entry, route.repo, route.ref);
          },
        });
      } catch (e) {
        result = e instanceof Error ? e : new Error(String(e));
      }
      await announced;
      try {
        await this.finishRun(id, entry, job, result);
      } catch (e) {
        // For example the patch could not be written: never leave the entry "running".
        this.log("error", "run_save_failed", errorMessage(e), entry.identifier);
        this.set(entry, { status: "failed", interruptions: 0 });
        await this.post(
          id,
          `autoforge could not save the run result: ${errorMessage(e)}\n\n${RETRY_HINT}`,
          true,
        );
      }
      await this.save();
    })()
      .catch((e) => this.log("error", "run_handler_failed", errorMessage(e), entry.identifier))
      .finally(() => this.jobs.delete(id));
    this.jobs.set(id, job);
  }

  /** Called once the sandbox exists and the clone starts. */
  private async announce(id: string, entry: IssueEntry, repo: string, ref: string): Promise<void> {
    this.dockerDown = false;
    entry.waiting = undefined;
    await this.o.linear
      .moveToStarted(id)
      .catch((e) => this.log("warn", "move_failed", errorMessage(e), entry.identifier));
    await this.post(id, `Running on \`${repo}@${ref}\` in a sandbox.`);
  }

  private async finishRun(
    id: string,
    entry: IssueEntry,
    job: Job,
    result: RunResult | Error,
  ): Promise<void> {
    if (job.dropped) return;
    // Only a run the stop actually cut short stays "running" for the next start to re-queue.
    const cut = result instanceof Error || result.reason === "aborted";
    if (this.stopping.signal.aborted && cut) return;
    if (result instanceof Error) {
      this.set(entry, { status: "failed", interruptions: 0 });
      await this.post(
        id,
        `autoforge could not start the run: ${result.message}\n\n${RETRY_HINT}`,
        true,
      );
      return;
    }
    if (result.reason === "sandbox_unavailable") {
      this.dockerDown = true;
      this.state.dailyRuns.count = Math.max(0, this.state.dailyRuns.count - 1);
      this.set(entry, { status: "queued" });
      this.log("warn", "docker_unavailable", result.message ?? "", entry.identifier);
      for (const [qid, q] of this.queue()) {
        if (q.waiting === "docker") continue;
        q.waiting = "docker";
        await this.post(
          qid,
          "Waiting for Docker: it is not running. The run starts by itself once Docker is back.",
        );
      }
      return;
    }
    if (result.status === "changed") await writePatch(this.o.stateDir, result.id, result.patch);
    this.set(entry, {
      status: result.status === "changed" ? "awaiting_approval" : result.status,
      run: {
        ...withoutOutput(result),
        ...(result.message ? { message: this.mask(result.message) } : {}),
      },
      interruptions: 0,
    });
    this.log(
      "info",
      "run_finished",
      result.reason ? `${result.status} (${result.reason})` : result.status,
      entry.identifier,
    );
    const secret = result.status === "changed" && this.mask(result.patch) !== result.patch;
    this.enqueue(id, resultComment(result, entry, secret), true);
    await this.save();
    await this.flushOutbox();
  }

  private async handleComments(issue: LinearIssue, entry: IssueEntry): Promise<void> {
    for (const c of issue.comments) {
      if (entry.handledCommentIds.includes(c.id) || c.user?.id !== this.state.viewerId) continue;
      const gate = entry.lastResultCommentAt;
      if (!gate || !(Date.parse(c.createdAt) > Date.parse(gate))) continue; // unparsable dates fail closed
      const command = parseCommand(c.body);
      if (!command) continue;
      entry.handledCommentIds.push(c.id);
      this.log("info", "command", `/${command.kind}`, issue.identifier);
      await this.apply(issue.id, command, true);
    }
  }

  private entryOf(issueId: string): IssueEntry | undefined {
    return Object.hasOwn(this.state.issues, issueId) ? this.state.issues[issueId] : undefined;
  }

  /** Same checks for Linear comments and the status endpoint. `reply` comments on a wrong state. */
  private async apply(
    issueId: string,
    command: Command,
    reply: boolean,
  ): Promise<CommandOutcome | null> {
    const entry = this.entryOf(issueId);
    if (!entry) return null;
    const valid =
      command.kind === "retry"
        ? RETRYABLE.includes(entry.status)
        : entry.status === "awaiting_approval";
    if (!valid) {
      const message = `\`/${command.kind}\` did nothing: it only works ${VALID_WHEN[command.kind]} (current status: ${entry.status.replaceAll("_", " ")}).`;
      if (reply) await this.post(issueId, message);
      return { ok: false, message };
    }
    if (command.kind === "publish") {
      this.startPublish(issueId, entry, command.force);
      return { ok: true, message: "publishing" };
    }
    // State first, then the irreversible patch delete, so a crash never leaves a status without its patch.
    const patchOf = entry.status === "awaiting_approval" ? entry.run?.id : undefined;
    if (command.kind === "discard") {
      this.set(entry, { status: "discarded" });
      await this.save();
      if (patchOf) await this.dropPatch(patchOf, entry.identifier);
      await this.post(issueId, "Discarded. Nothing was published.");
      return { ok: true, message: "discarded" };
    }
    this.set(entry, {
      status: "queued",
      feedback: command.feedback,
      interruptions: 0,
      queuedAt: this.now().toISOString(),
      waiting: undefined,
    });
    await this.save();
    if (patchOf) await this.dropPatch(patchOf, entry.identifier);
    const why = command.feedback ? " with your feedback" : "";
    await this.post(
      issueId,
      `Queued for autoforge again${why} (position ${this.position(issueId)}).`,
      true,
    );
    return { ok: true, message: "queued" };
  }

  private startPublish(id: string, entry: IssueEntry, force: boolean): void {
    this.set(entry, { status: "publishing" });
    const done = (async () => {
      await this.save(); // before the push, so a crash never repeats a publish silently
      let out;
      try {
        const patch = entry.run ? await readPatch(this.o.stateDir, entry.run.id) : null;
        if (!entry.run || patch === null) {
          throw new PublishError("invalid_result", "the stored patch is missing");
        }
        if (this.mask(patch) !== patch) {
          throw new PublishError("invalid_result", "the patch contains one of your secrets");
        }
        const title = this.latest.get(id)?.title ?? entry.run.task.split("\n")[0]?.trim();
        out = await publishToGitHub(
          { ...entry.run, patch, logs: "" },
          {
            repo: entry.repo,
            // Only the identifier and title: the description and discussion stay in Linear.
            body: `${entry.identifier}: ${title}\n\nOpened by autoforge from Linear issue ${entry.identifier}.`,
            token: this.secrets.githubToken,
            base: entry.ref,
            force,
            gitUrl: this.repoUrl(entry.repo),
            apiUrl: this.o.github?.apiUrl,
            fetch: this.o.github?.fetch,
            signal: AbortSignal.any([
              this.stopping.signal,
              AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
            ]),
          },
        );
      } catch (e) {
        if (this.stopping.signal.aborted) return; // stays "publishing"; the next start hands it back
        const code = e instanceof PublishError ? e.code : "error";
        const hint =
          code === "branch_exists"
            ? "Reply `/publish force` to overwrite the branch."
            : code === "github_api_error" || code === "aborted"
              ? CHECK_GITHUB_HINT
              : code === "invalid_result"
                ? "Reply `/retry <feedback>` to run it again, or `/discard` to drop it."
                : "Reply `/publish` to try again.";
        this.set(entry, { status: "awaiting_approval" });
        this.log("warn", "publish_failed", `${code}: ${errorMessage(e)}`, entry.identifier);
        await this.post(id, `Publishing failed (\`${code}\`): ${errorMessage(e)}\n\n${hint}`);
        await this.save();
        return;
      }
      // The PR exists: nothing below may move the entry back from "published".
      this.set(entry, { status: "published", prUrl: out.prUrl });
      await this.save();
      this.log("info", "published", out.prUrl, entry.identifier);
      if (entry.run) await this.dropPatch(entry.run.id, entry.identifier);
      await this.post(id, `Draft PR opened: ${out.prUrl}`);
      await this.o.linear
        .attachUrl(id, out.prUrl, "Draft PR (autoforge)")
        .catch((e) => this.log("warn", "attach_failed", errorMessage(e), entry.identifier));
      await this.save();
    })()
      .catch((e) => this.log("error", "publish_handler_failed", errorMessage(e), entry.identifier))
      .finally(() => this.publishes.delete(done));
    this.publishes.add(done);
  }

  /** Queues a daemon comment, saves state, then sends. `gate` moves the command window. */
  private async post(issueId: string, text: string, gate = false): Promise<void> {
    this.enqueue(issueId, text, gate);
    await this.save();
    await this.flushOutbox();
  }

  /** Intent first: the comment is in state before any HTTP call, so a crash never loses or repeats work. */
  private enqueue(issueId: string, text: string, gate: boolean): void {
    this.state.outbox.push({ issueId, body: `${MARKER}\n${this.mask(text)}`, gate, attempts: 0 });
  }

  /** Sends pending comments in insertion order; a failure holds back later ones for that issue. */
  private flushOutbox(): Promise<void> {
    this.sending = this.sending.then(() => this.sendAll()).catch(() => undefined);
    return this.sending;
  }

  private async sendAll(): Promise<void> {
    const blocked = new Set<string>();
    for (const item of [...this.state.outbox]) {
      if (blocked.has(item.issueId)) continue;
      try {
        const c = await this.o.linear.comment(item.issueId, item.body);
        this.state.outbox = this.state.outbox.filter((i) => i !== item);
        if (item.gate) this.gate(item.issueId, c.createdAt);
      } catch (e) {
        blocked.add(item.issueId);
        item.attempts++;
        this.log(
          "warn",
          "comment_failed",
          `${errorMessage(e)}; will retry`,
          this.state.issues[item.issueId]?.identifier,
        );
        if (item.attempts >= 100) {
          this.state.outbox = this.state.outbox.filter((i) => i !== item);
          this.log(
            "error",
            "comment_dropped",
            "gave up on a comment after 100 attempts",
            this.state.issues[item.issueId]?.identifier,
          );
        }
      }
      await this.save();
    }
  }

  private gate(issueId: string, at: string): void {
    const entry = this.state.issues[issueId];
    if (entry) entry.lastResultCommentAt = at;
  }

  private set(entry: IssueEntry, fields: Partial<IssueEntry>): void {
    Object.assign(entry, fields, { updatedAt: this.now().toISOString() });
  }

  /** Saves are chained so an older snapshot can never land after a newer one. */
  private save(): Promise<void> {
    this.saving = this.saving
      .then(() => saveState(this.o.stateDir, this.state))
      .catch((e) => this.log("error", "state_save_failed", errorMessage(e)));
    return this.saving;
  }

  private log(level: LogEntry["level"], event: string, message: string, issue?: string): void {
    (this.o.log ?? defaultLog)({
      level,
      event,
      message: this.mask(message),
      ...(issue ? { issue } : {}),
    });
  }
}

function resultComment(r: RunResult, entry: IssueEntry, secret: boolean): string {
  const where = `\`${entry.repo}@${entry.ref}\``;
  if (r.status === "no_changes") {
    return `autoforge finished on ${where} without changing any files.\n\n${RETRY_HINT}`;
  }
  if (r.status === "timed_out") {
    return `autoforge stopped on ${where}: ${r.message ?? "the run hit its timeout"}\n\n${RETRY_HINT}`;
  }
  if (r.status === "failed") {
    return `autoforge failed on ${where} (\`${r.reason ?? "error"}\`): ${r.message ?? "unknown error"}\n\n${RETRY_HINT}`;
  }
  const lines = r.patch.replace(/\n$/, "").split("\n");
  const shown = lines.slice(0, 80).join("\n");
  // A fence longer than any backtick run in the patch, so the patch cannot close it.
  const fence = "`".repeat(Math.max(3, ...[...shown.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  const { added, removed } = diffstat(r.patch);
  const files = r.filesChanged.slice(0, 20).map((f) => `- ${f}`);
  if (r.filesChanged.length > 20) files.push(`- and ${r.filesChanged.length - 20} more`);
  return [
    `autoforge finished on ${where}: ${r.filesChanged.length} file(s) changed, +${added} -${removed}.`,
    "",
    ...files,
    "",
    `${fence}diff`,
    shown,
    fence,
    ...(lines.length > 80 ? [`(first 80 of ${lines.length} lines)`] : []),
    ...(secret ? ["", SECRET_WARNING] : []),
    "",
    "Reply `/publish` to open a draft PR (`/publish force` overwrites an existing branch), `/retry <feedback>` to run again with your feedback, or `/discard` to drop it.",
  ].join("\n");
}

function diffstat(patch: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++ ")) added++;
    else if (line.startsWith("-") && !line.startsWith("--- ")) removed++;
  }
  return { added, removed };
}

function withoutOutput(r: RunResult): Omit<RunResult, "patch" | "logs"> {
  const copy: Partial<RunResult> = { ...r };
  delete copy.patch;
  delete copy.logs;
  return copy as Omit<RunResult, "patch" | "logs">;
}

function pick(env: Record<string, string>, names: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

const localDate = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

const defaultLog = (e: LogEntry) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), ...e }));
