# Contributing

1. `pnpm install`
2. `pnpm test` runs everything. Docker tests are skipped when Docker is not running; set
   `AUTOFORGE_REQUIRE_DOCKER=1` to make them fail instead.
3. Before a PR: `pnpm fix && pnpm lint && pnpm typecheck && pnpm test`.

Write the failing test first. Tests never call a real LLM; use `test/fake-agent.ts`.
Runtime dependencies are not accepted. Use Node built-ins.
