import js from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import security from "eslint-plugin-security";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "scripts/**",
      "site/**",
      "*.config.js",
      "*.config.mjs",
      "*.config.cjs",
      "release.config.mjs",
      "release.config.dev.mjs",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.ts"],
    extends: [...tseslint.configs.strictTypeChecked, ...tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
        project: ["./tsconfig.json", "./tsconfig.test.json"],
      },
      globals: {
        console: "readonly",
        process: "readonly",
        Buffer: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        global: "readonly",
        Bun: "readonly",
        setInterval: "readonly",
        setTimeout: "readonly",
        clearInterval: "readonly",
        clearTimeout: "readonly",
      },
    },
    plugins: {
      "simple-import-sort": simpleImportSort,
      security: security,
    },
    rules: {
      ...security.configs.recommended.rules,

      // Import sorting (auto-fixable)
      // https://github.com/lydell/eslint-plugin-simple-import-sort
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",

      // TypeScript rules — overrides / extensions on strictTypeChecked preset
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/explicit-function-return-type": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/strict-boolean-expressions": "error",
      "@typescript-eslint/no-unnecessary-condition": "warn",
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/no-require-imports": "error",
      // Allow numbers in template literals (safe and idiomatic for logging)
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],

      // Consistent type imports (auto-fixable)
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],

      // Complexity reduction rules
      complexity: ["warn", { max: 15 }],
      "max-depth": ["error", 4],
      "max-lines-per-function": [
        "warn",
        {
          max: 120,
          skipBlankLines: true,
          skipComments: true,
        },
      ],
      "max-params": ["warn", 5],
      "max-statements": ["warn", 50],
      "max-nested-callbacks": ["error", 3],

      // Code quality rules
      "prefer-const": "error",
      "no-var": "error",
      "object-shorthand": "error",
      "prefer-arrow-callback": "error",
      "prefer-template": "error",
      "no-duplicate-imports": "error",
      "no-debugger": "error",
      "no-unused-expressions": "error",

      // Best practices
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
      "no-eval": "error",
      "no-implied-eval": "error",
      "prefer-promise-reject-errors": "error",

      // Performance rules
      "no-await-in-loop": "warn",
      "require-atomic-updates": "error",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      "no-console": "off",
      "prefer-const": "error",
      "no-var": "error",
      "no-debugger": "error",
    },
  },
  {
    // Relaxed rules for test files
    files: ["**/*.test.ts", "**/test/**/*.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/unbound-method": "off",
      // Empty arrow functions are common placeholders in test mocks
      "@typescript-eslint/no-empty-function": "off",
      // Dot notation not enforced for process.env in tests
      "@typescript-eslint/dot-notation": "off",
      // Test describe blocks can legitimately be long
      "max-lines-per-function": "off",
    },
  },
  // Prettier config must come last to override conflicting rules
  prettierConfig,
);
