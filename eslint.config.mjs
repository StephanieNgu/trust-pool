import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "artifacts/**", "cache/**", "coverage/**", "typechain-types/**"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Hardhat config, deploy scripts and contract tests are CommonJS run under Node + Mocha.
    files: ["hardhat.config.js", "scripts/**/*.js", "test/**/*.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { ...globals.node, ...globals.mocha }
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off"
    }
  }
);
