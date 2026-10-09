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

    it("caps the number of processes", async () => {
      const s = await ctx.sandbox().create();
      try {
        let out = "";
        await s.exec(["cat", "/sys/fs/cgroup/pids.max"], { onStdout: (c) => (out += c) });
        expect(out.trim()).toBe("4096");
      } finally {
        await s.destroy();
      }
    });

    it("stops the process inside the container on abort", async () => {
      const s = await ctx.sandbox().create();
      try {
        const ac = new AbortController();
        const running = s.exec(["sleep", "300"], { signal: ac.signal });
        setTimeout(() => ac.abort(), 500);
        await running;
        let out = "";
        await s.exec(["sh", "-c", "ps -eo pid,comm | grep -c sleep || true"], {
          onStdout: (c) => (out += c),
        });
        expect(out.trim()).toBe("1"); // only PID 1
      } finally {
        await s.destroy();
      }
    });

    it("drops every capability and blocks privilege escalation for the agent", async () => {
      const s = await ctx.sandbox().create();
      try {
        let out = "";
        await s.exec(["cat", "/proc/self/status"], { onStdout: (c) => (out += c) });
        const field = (name: string) => new RegExp(`^${name}:\\s*(\\S+)`, "m").exec(out)?.[1];
        expect(field("CapEff")).toBe("0000000000000000");
        expect(field("NoNewPrivs")).toBe("1");
        // Only CAP_CHOWN (bit 0) is left in the bounding set, for the root prep step.
        expect(field("CapBnd")).toBe("0000000000000001");
      } finally {
        await s.destroy();
      }
    });

    it("rejects create with an aborted signal and leaves no container", async () => {
      const before = await containers();
      const created = ctx.sandbox().create({ signal: AbortSignal.abort() });
      const outcome = await created.then(
        (s) => s.destroy().then(() => "resolved"),
        () => "rejected",
      );
      expect(outcome).toBe("rejected");
      expect(await containers()).toBe(before);
    });

    it("removes the container when create is aborted while docker run is in flight", async () => {
      const before = await containers();
      for (const ms of [50, 150, 300, 600]) {
        const ac = new AbortController();
        setTimeout(() => ac.abort(), ms);
        await ctx
          .sandbox()
          .create({ signal: ac.signal })
          .then((s) => s.destroy())
          .catch(() => {});
      }
      expect(await containers()).toBe(before);
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

    it("masks env values passed to the agent", async () => {
      const r = await run(
        options(ctx, "echo-env", {
          agent: { command: fakeAgent("echo-env"), env: { SECRET_KEY: "sk-docker-123456" } },
        }),
      );
      expect(r.logs).toContain("key=***");
    });
  },
);
