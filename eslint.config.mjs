import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules/", "dist/", ".claude/", "eslint.config.mjs"] },
  ...tseslint.configs.recommended,
  {
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": ["error", {
        allowForKnownSafeCalls: [{ from: "package", name: "test", package: "node:test" }],
      }],
      "@typescript-eslint/no-misused-promises": "error",
      "no-restricted-imports": ["error", { paths: [{ name: "node:sqlite", message: "SQLCipher only: node:sqlite stores plaintext." }] }],
    },
  },
);
