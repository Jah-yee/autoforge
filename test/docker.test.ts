import { beforeAll, describe, expect, it } from "vitest";
import { DockerSandbox } from "../src/docker.js";
import { run } from "../src/index.js";
import { proc } from "../src/proc.js";
import { fakeAgent } from "./fake-agent.js";
import { runSafetyScenarios } from "./safety-scenarios.js";
import { options, runScenarios, type ScenarioContext } from "./scenarios.js";

const dockerUp = (await proc("docker", ["info"])).exitCode === 0;
const IMAGE = "node:22";

const ctx: ScenarioContext = {
  sandbox: () => new DockerSandbox({ image: IMAGE }),
  repo: () => ({ url: "https://github.com/octocat/Hello-World.git", ref: "master" }),
  target: "README",
  timeoutMs: 20_000,
};

const containers = async () =>
  (await proc("docker", ["ps", "-aq", "--filter", "label=autoforge=1"])).stdout.trim();

describe.skipIf(!dockerUp && !process.env.AUTOFORGE_REQUIRE_DOCKER)(
  "DockerSandbox",
  { timeout: 180_000 },
  () => {
    beforeAll(async () => {
      await proc("docker", ["pull", "-q", IMAGE]);
    }, 600_000);

    runScenarios(ctx);
    runSafetyScenarios(ctx);

    it("uses /workspace and round-trips files", async () => {
      const s = await ctx.sandbox().create();
      try {
        expect(s.workdir).toBe("/workspace");
        await s.writeFile("/workspace/a/b.txt", "hi");
        let out = "";
        await s.exec(["cat", "/workspace/a/b.txt"], { onStdout: (c) => (out += c) });
        expect(out).toBe("hi");
      } finally {
        await s.destroy();
      }
    });

    it("runs the agent as a non-root user", async () => {
      const r = await run(options(ctx, "id"));
      expect(r.logs.split("\n")).toContain("1000");
    });

    it("removes its container after the run", async () => {
      const before = await containers();
      await run(options(ctx, "noop"));
      expect(await containers()).toBe(before);
    });

    it("has no network with network: none", async () => {
      const r = await run(
        options(ctx, "noop", { sandbox: new DockerSandbox({ image: IMAGE, network: "none" }) }),
      );
      expect(r).toMatchObject({ status: "failed", reason: "clone_failed" });
    });

    it("passes env values without putting them on the docker command line", async () => {
      const r = await run(
        options(ctx, "echo-env", {
          agent: { command: fakeAgent("echo-env"), env: { SECRET_KEY: "sk-docker-123456" } },
        }),
      );
      expect(r.logs).toContain("key=***");
    });
  },
);
