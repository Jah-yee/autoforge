import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "apps/desktop/dist", "apps/desktop/src-tauri"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
