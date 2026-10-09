import type { LinearApi, LinearComment, LinearIssue, LinearUser } from "../../src/serve/linear.js";

export const ME: LinearUser = { id: "user-me", name: "Mia" };
export const OTHER: LinearUser = { id: "user-other", name: "Bo" };

/** In-memory Linear. Daemon comments are authored by ME, as with a real personal API key. */
export class FakeLinear implements LinearApi {
  readonly issues = new Map<string, LinearIssue>();
  readonly posted: { issueId: string; body: string }[] = [];
  readonly started: string[] = [];
  readonly attached: { issueId: string; url: string; title: string }[] = [];
  /** Every call throws this while set. */
  failWith: Error | null = null;
  /** comment() throws while set. */
  failComments = false;
  private seq = 0;

  constructor(private readonly now: () => Date) {}

  addIssue(fields: Partial<LinearIssue> & { id: string }): LinearIssue {
    const issue: LinearIssue = {
      identifier: `ENG-${this.issues.size + 1}`,
      title: "Fix the greeting",
      description: "Make it friendlier.",
      updatedAt: this.now().toISOString(),
      assigneeId: ME.id,
      stateType: "unstarted",
      labels: ["autoforge"],
      team: { id: "team-eng", key: "ENG", name: "Engineering" },
      project: null,
      comments: [],
      ...fields,
    };
    this.issues.set(issue.id, issue);
    return issue;
  }

  /** A person edits the issue in Linear. */
  update(id: string, fields: Partial<LinearIssue>): void {
    Object.assign(this.get(id), fields, { updatedAt: this.now().toISOString() });
  }

  userComment(id: string, body: string, user: LinearUser = ME): LinearComment {
    const c: LinearComment = {
      id: `comment-${++this.seq}`,
      body,
      createdAt: this.now().toISOString(),
      user,
    };
    const issue = this.get(id);
    issue.comments.push(c);
    issue.updatedAt = c.createdAt;
    return c;
  }

  /** What the daemon posted on an issue, without the marker line. */
  said(id: string): string[] {
    return this.posted
      .filter((p) => p.issueId === id)
      .map((p) => p.body.replace(/^<!-- autoforge -->\n/, ""));
  }

  async viewer(): Promise<LinearUser> {
    this.check();
    return ME;
  }

  async changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]> {
    this.check();
    return [...this.issues.values()]
      .filter(
        (i) =>
          (i.assigneeId === ME.id && Date.parse(i.updatedAt) > Date.parse(since)) ||
          trackedIds.includes(i.id),
      )
      .map((i) => structuredClone(i));
  }

  async comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }> {
    this.check();
    if (this.failComments) throw new Error("Linear is having a moment");
    this.posted.push({ issueId, body });
    const c = this.userComment(issueId, body);
    return { id: c.id, createdAt: c.createdAt };
  }

  async moveToStarted(issueId: string): Promise<void> {
    this.check();
    this.started.push(issueId);
    this.get(issueId).stateType = "started";
  }

  async attachUrl(issueId: string, url: string, title: string): Promise<void> {
    this.check();
    this.attached.push({ issueId, url, title });
  }

  private check(): void {
    if (this.failWith) throw this.failWith;
  }

  private get(id: string): LinearIssue {
    const issue = this.issues.get(id);
    if (!issue) throw new Error(`no issue ${id}`);
    return issue;
  }
}
