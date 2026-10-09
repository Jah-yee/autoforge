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
