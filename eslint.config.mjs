import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/.next*/**", "**/node_modules/**", ".firecrawl/**", "**/test-results/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        AbortController: "readonly",
        AbortSignal: "readonly",
        Blob: "readonly",
        console: "readonly",
        document: "readonly",
        fetch: "readonly",
        FileReader: "readonly",
        localStorage: "readonly",
        process: "readonly",
        ReadableStream: "readonly",
        Request: "readonly",
        Response: "readonly",
        TextDecoder: "readonly",
        TextEncoder: "readonly",
        URL: "readonly",
        window: "readonly"
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  }
);
