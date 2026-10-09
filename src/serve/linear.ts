export type LinearUser = { id: string; name: string };

export type LinearComment = {
  id: string;
  body: string;
  createdAt: string;
  /** null for comments made by integrations. */
  user: LinearUser | null;
};

export type LinearIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  /** The issue's page in Linear, for example https://linear.app/acme/issue/ENG-123/title. */
  url: string;
  updatedAt: string;
  assigneeId: string | null;
  /** Workflow state type: triage, backlog, unstarted, started, completed or canceled. */
  stateType: string;
  labels: string[];
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  /** Up to the 100 newest comments, oldest first. */
  comments: LinearComment[];
};

export interface LinearApi {
  viewer(): Promise<LinearUser>;
  /**
   * Issues assigned to the viewer and updated after `since`, plus every issue whose id is in
   * `trackedIds` whatever its assignee or update time. Paginated internally.
   */
  changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]>;
  comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }>;
  /** Moves the issue to its team's first workflow state of type "started". */
  moveToStarted(issueId: string): Promise<void>;
  attachUrl(issueId: string, url: string, title: string): Promise<void>;
}

export class LinearError extends Error {
  override name = "LinearError";

  constructor(
    message: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

export type LinearClientOptions = { apiKey: string; url?: string; fetch?: typeof fetch };

type RawIssue = {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  url: string;
  updatedAt: string;
  assignee: { id: string } | null;
  state: { type: string };
  team: { id: string; key: string; name: string };
  project: { id: string; name: string } | null;
  labels: { nodes: { name: string }[] };
  comments: { nodes: LinearComment[] };
};

type IssuePage = {
  issues: { nodes: RawIssue[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };
};

// ponytail: last 100 comments and 50 labels per issue; paginate them if real issues get longer.
const ISSUE_FIELDS = `id identifier title description url updatedAt
  assignee { id } state { type } team { id key name } project { id name }
  labels(first: 50) { nodes { name } }
  comments(last: 100) { nodes { id body createdAt user { id name } } }`;

const toIssue = (r: RawIssue): LinearIssue => ({
  id: r.id,
  identifier: r.identifier,
  title: r.title,
  description: r.description,
  url: r.url,
  updatedAt: r.updatedAt,
  assigneeId: r.assignee?.id ?? null,
  stateType: r.state.type,
  labels: r.labels.nodes.map((l) => l.name),
  team: r.team,
  project: r.project,
  comments: r.comments.nodes.toSorted((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
});

function retryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class LinearClient implements LinearApi {
  private readonly url: string;
  private readonly doFetch: typeof fetch;

  constructor(private readonly o: LinearClientOptions) {
    this.url = o.url ?? "https://api.linear.app/graphql";
    this.doFetch = o.fetch ?? fetch;
  }

  private async gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.doFetch(this.url, {
        method: "POST",
        // Personal API keys go in the header as is, without "Bearer".
        headers: { Authorization: this.o.apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new LinearError(`Linear request failed: ${errorMessage(e)}`);
    }
    const text = await res.text().catch(() => "");
    let json: { data?: T; errors?: { message?: string }[] } = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === "object") json = parsed as typeof json;
    } catch {
      // reported below with the raw text
    }
    if (!res.ok || json.errors?.length || !json.data) {
      const detail = json.errors?.map((e) => e.message).join("; ") || text.slice(0, 200);
      throw new LinearError(
        `Linear API error (status ${res.status}): ${detail}`,
        retryAfter(res.headers.get("retry-after")),
      );
    }
    return json.data;
  }

  async viewer(): Promise<LinearUser> {
    const d = await this.gql<{ viewer: LinearUser }>("query { viewer { id name } }");
    return d.viewer;
  }

  async changedIssues(since: string, trackedIds: string[]): Promise<LinearIssue[]> {
    const mine = { assignee: { isMe: { eq: true } }, updatedAt: { gt: since } };
    const filter = trackedIds.length ? { or: [mine, { id: { in: trackedIds } }] } : mine;
    const out: LinearIssue[] = [];
    let after: string | null = null;
    for (let pages = 0; ; pages++) {
      if (pages >= 200) throw new LinearError("pagination did not terminate");
      const d: IssuePage = await this.gql<IssuePage>(
        `query($filter: IssueFilter!, $after: String) {
          issues(filter: $filter, first: 50, after: $after) {
            nodes { ${ISSUE_FIELDS} }
            pageInfo { hasNextPage endCursor }
          }
        }`,
        { filter, after },
      );
      out.push(...d.issues.nodes.map(toIssue));
      const { hasNextPage, endCursor } = d.issues.pageInfo;
      if (!hasNextPage || !endCursor || endCursor === after) break;
      after = endCursor;
    }
    return out;
  }

  async comment(issueId: string, body: string): Promise<{ id: string; createdAt: string }> {
    const d = await this.gql<{
      commentCreate: { success: boolean; comment: { id: string; createdAt: string } | null };
    }>(
      `mutation($input: CommentCreateInput!) {
        commentCreate(input: $input) { success comment { id createdAt } }
      }`,
      { input: { issueId, body } },
    );
    if (!d.commentCreate.success || !d.commentCreate.comment)
      throw new LinearError("Linear did not create the comment");
    return d.commentCreate.comment;
  }

  async moveToStarted(issueId: string): Promise<void> {
    const d = await this.gql<{
      issue: { team: { states: { nodes: { id: string; position: number }[] } } };
    }>(
      `query($id: String!) {
        issue(id: $id) { team { states(filter: { type: { eq: "started" } }) { nodes { id position } } } }
      }`,
      { id: issueId },
    );
    const first = d.issue.team.states.nodes.toSorted((a, b) => a.position - b.position)[0];
    if (!first) return;
    const u = await this.gql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) { success }
      }`,
      { id: issueId, stateId: first.id },
    );
    if (!u.issueUpdate.success) throw new LinearError("Linear did not move the issue");
  }

  async attachUrl(issueId: string, url: string, title: string): Promise<void> {
    const d = await this.gql<{ attachmentCreate: { success: boolean } }>(
      `mutation($input: AttachmentCreateInput!) { attachmentCreate(input: $input) { success } }`,
      { input: { issueId, url, title } },
    );
    if (!d.attachmentCreate.success) throw new LinearError("Linear did not attach the URL");
  }
}
