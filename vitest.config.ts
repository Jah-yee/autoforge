import { configDefaults, defineConfig } from "vitest/config";

// apps/desktop has its own Vitest setup (jsdom) and runs its tests itself.
export default defineConfig({
  test: { testTimeout: 30_000, exclude: [...configDefaults.exclude, "apps/**"] },
});
