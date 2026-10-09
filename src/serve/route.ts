import { parseRepoSpec, type AgentConfig, type Config } from "./config.js";
import type { LinearIssue } from "./linear.js";

export type Route = { repo: string; ref: string; agent: AgentConfig };

/** Label `repo:owner/name[@branch]`, then project rule, then team rule, then defaultRepo. */
export function routeIssue(issue: LinearIssue, config: Config): Route | null {
  for (const label of issue.labels) {
    const spec = label.startsWith("repo:") ? parseRepoSpec(label.slice(5)) : null;
    if (spec) return { ...spec, agent: config.agent };
  }
  const { project, team } = issue;
  const rule =
    config.rules.find(
      (r) =>
        r.linearProject !== undefined &&
        project !== null &&
        (r.linearProject === project.name || r.linearProject === project.id),
    ) ??
    config.rules.find(
      (r) =>
        r.linearTeam !== undefined && (r.linearTeam === team.key || r.linearTeam === team.name),
    );
  const ruleSpec = rule ? parseRepoSpec(rule.repo) : null;
  if (rule && ruleSpec) return { ...ruleSpec, agent: { ...config.agent, ...rule.agent } };
  const fallback = config.defaultRepo ? parseRepoSpec(config.defaultRepo) : null;
  return fallback ? { ...fallback, agent: config.agent } : null;
}
