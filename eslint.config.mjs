import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";

export default defineConfig([
    js.configs.recommended,
    {
        files: ["**/*.{js,mjs,cjs}"],
        plugins: { js },
        languageOptions: { globals: { ...globals.browser, ...globals.node } },
        rules: {
            "sort-imports": [
                "error",
                {
                    allowSeparatedGroups: true
                }
            ]
        }
    },
    {
        ignores: ["dist/**", "docs/**", "node_modules/", "**/vendor/*.js"]
    },
    {
        files: ["**/*.test.js", "**/*.spec.js"], // 👈 Only apply to test files
        languageOptions: {
            globals: {
                ...globals.jest // 👈 Add Jest globals like `describe`, `it`, `expect`
            }
        },
        rules: {
            // Optional: Jest-specific rules
            "no-undef": "off" // Jest defines globals, so we disable this warning
        }
    }
]);
