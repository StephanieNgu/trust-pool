import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", ".npm-cache/**"]
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["frontend/src/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        document: "readonly",
        fetch: "readonly",
        window: "readonly"
      }
    }
  }
);
