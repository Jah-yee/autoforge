import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export type AgentConfig = {
  image: string;
  command: string[];
  /** Names of environment variables passed to the agent. */
  envFrom: string[];
  timeoutMinutes: number;
};

export type Rule = {
  linearProject?: string;
  linearTeam?: string;
  repo: string;
  /** Shallow-merged over the top-level agent. */
  agent?: Partial<AgentConfig>;
};

export type Config = {
  pollSeconds: number;
  maxConcurrent: number;
  dailyRunLimit: number;
  approvalExpiryDays: number;
  pickup: "labelled" | "all-assigned";
  label: string;
  comments: "all" | "mine";
  defaultRepo?: string;
  rules: Rule[];
  agent: AgentConfig;
  template: string;
};

export type Secrets = {
  linearApiKey: string;
  githubToken: string;
  cloneToken?: string;
  /** Values for every name in agent.envFrom and in the rules' agent.envFrom. */
  agentEnv: Record<string, string>;
};

export class ConfigError extends Error {
  override name = "ConfigError";
}

export const DEFAULT_TEMPLATE =
  "{title}\n\n{description}\n\nDiscussion (from issue participants):\n{comments}";

const CONFIG_KEYS = [
  "pollSeconds",
  "maxConcurrent",
  "dailyRunLimit",
  "approvalExpiryDays",
  "pickup",
  "label",
  "comments",
  "defaultRepo",
  "rules",
  "agent",
  "template",
];
const AGENT_KEYS = ["image", "command", "envFrom", "timeoutMinutes"];
const RULE_KEYS = ["linearProject", "linearTeam", "repo", "agent"];
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REPO_SPEC = /^([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)(?:@(.*))?$/;

type Obj = Record<string, unknown>;

function fail(message: string): never {
  throw new ConfigError(message);
}

const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** "owner/name" or "owner/name@branch" (branch defaults to main), or null when invalid. */
export function parseRepoSpec(spec: string): { repo: string; ref: string } | null {
  const m = REPO_SPEC.exec(spec);
  if (!m?.[1]) return null;
  const ref = m[2] ?? "main";
  if (!/^[\w./-]+$/.test(ref) || ref.startsWith("-")) return null;
  return { repo: m[1], ref };
}

function onlyKeys(o: Obj, allowed: string[], path: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) fail(`${path}.${key} is not a known field`);
  }
}

function num(o: Obj, key: string, path: string, def: number, min: number, integer = true): number {
  const v = o[key] ?? def;
  if (
    typeof v !== "number" ||
    !Number.isFinite(v) ||
    v < min ||
    (integer && !Number.isInteger(v))
  ) {
    fail(`${path}.${key} must be ${integer ? "an integer" : "a number"} of at least ${min}`);
  }
  return v;
}

function str(o: Obj, key: string, path: string, def?: string): string {
  const v = o[key] ?? def;
  if (typeof v !== "string" || !v) fail(`${path}.${key} must be a non-empty string`);
  return v;
}

function oneOf<T extends string>(o: Obj, key: string, path: string, values: readonly T[]): T {
  const v = o[key] ?? values[0];
  if (!values.includes(v as T)) fail(`${path}.${key} must be one of: ${values.join(", ")}`);
  return v as T;
}

function strings(
  o: Obj,
  key: string,
  path: string,
  what: string,
  minLength: number,
  pattern?: RegExp,
  def?: string[],
): string[] {
  const v = o[key] ?? def;
  const ok =
    Array.isArray(v) &&
    v.length >= minLength &&
    v.every((s) => typeof s === "string" && (!pattern || pattern.test(s)));
  if (!ok) fail(`${path}.${key} must be ${what}`);
  return v as string[];
}

function repoSpec(o: Obj, key: string, path: string): string {
  const v = str(o, key, path);
  if (!parseRepoSpec(v)) fail(`${path}.${key} must look like owner/name or owner/name@branch`);
  return v;
}

/** With `partial`, only the keys present are validated (a rule's agent override). */
function parseAgent(v: unknown, path: string, partial: boolean): Partial<AgentConfig> {
  if (!isObject(v)) fail(`${path} must be an object`);
  onlyKeys(v, AGENT_KEYS, path);
  const has = (key: string) => !partial || v[key] !== undefined;
  const out: Partial<AgentConfig> = {};
  if (has("image")) out.image = str(v, "image", path);
  if (has("command")) {
    out.command = strings(v, "command", path, "a list of at least one string", 1);
  }
  if (has("envFrom")) {
    out.envFrom = strings(
      v,
      "envFrom",
      path,
      "a list of environment variable names",
      0,
      ENV_NAME,
      [],
    );
  }
  if (has("timeoutMinutes")) out.timeoutMinutes = num(v, "timeoutMinutes", path, 30, 1, false);
  return out;
}

function parseRule(r: unknown, i: number): Rule {
  const path = `config.rules[${i}]`;
  if (!isObject(r)) fail(`${path} must be an object`);
  onlyKeys(r, RULE_KEYS, path);
  const hasProject = r.linearProject !== undefined;
  if (hasProject === (r.linearTeam !== undefined)) {
    fail(`${path} needs exactly one of linearProject or linearTeam`);
  }
  const rule: Rule = { repo: repoSpec(r, "repo", path) };
  if (hasProject) rule.linearProject = str(r, "linearProject", path);
  else rule.linearTeam = str(r, "linearTeam", path);
  if (r.agent !== undefined) rule.agent = parseAgent(r.agent, `${path}.agent`, true);
  return rule;
}

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) fail("config.json must contain a JSON object");
  onlyKeys(raw, CONFIG_KEYS, "config");
  const rules = raw.rules ?? [];
  if (!Array.isArray(rules)) fail("config.rules must be a list");
  return {
    pollSeconds: num(raw, "pollSeconds", "config", 30, 10),
    maxConcurrent: num(raw, "maxConcurrent", "config", 1, 1),
    dailyRunLimit: num(raw, "dailyRunLimit", "config", 20, 1),
    approvalExpiryDays: num(raw, "approvalExpiryDays", "config", 14, 1),
    pickup: oneOf(raw, "pickup", "config", ["labelled", "all-assigned"] as const),
    label: str(raw, "label", "config", "autoforge"),
    comments: oneOf(raw, "comments", "config", ["all", "mine"] as const),
    defaultRepo: raw.defaultRepo === undefined ? undefined : repoSpec(raw, "defaultRepo", "config"),
    rules: rules.map(parseRule),
    agent: parseAgent(raw.agent, "config.agent", false) as AgentConfig,
    template: str(raw, "template", "config", DEFAULT_TEMPLATE),
  };
}

export async function loadConfig(dir: string): Promise<Config> {
  const path = join(dir, "config.json");
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return fail(`${path} not found. Create it (see the README section "autoforge serve").`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return fail(`${path} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseConfig(raw);
}

export function readSecrets(config: Config, env: Record<string, string | undefined>): Secrets {
  const need = (name: string): string =>
    env[name] || fail(`${name} is not set. Put it in ~/.autoforge/env or the environment.`);
  const names = new Set([
    ...config.agent.envFrom,
    ...config.rules.flatMap((r) => r.agent?.envFrom ?? []),
  ]);
  return {
    linearApiKey: need("LINEAR_API_KEY"),
    githubToken: need("GITHUB_TOKEN"),
    cloneToken: env.CLONE_TOKEN || undefined,
    agentEnv: Object.fromEntries([...names].map((n) => [n, need(n)])),
  };
}

/** Reads `<dir>/env` (KEY=value lines). Absent is fine; group or world access is refused. */
export async function readEnvFile(dir: string): Promise<Record<string, string | undefined>> {
  const path = join(dir, "env");
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e;
  }
  if (mode & 0o077)
    fail(`${path} must be readable and writable only by you. Run: chmod 600 ${path}`);
  return parseEnv(await readFile(path, "utf8"));
}
