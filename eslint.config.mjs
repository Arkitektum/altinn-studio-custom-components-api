import { defineConfig } from "eslint/config";
import globals from "globals";
import js from "@eslint/js";

export default defineConfig([
    js.configs.recommended,
    {
        files: ["**/*.{js,mjs,cjs}"],
        languageOptions: { globals: { ...globals.node } },
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
        ignores: ["node_modules/"]
    }
]);
