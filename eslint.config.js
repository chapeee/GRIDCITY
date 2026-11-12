import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/dist/**',
      '**/dist-demo/**',
      '**/node_modules/**',
      'coverage/**',
      'test-results/**',
      'playwright-report/**',
      'release/**',
      'website/**',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: reactHooks.configs.recommended.rules,
    languageOptions: { globals: globals.browser },
  },
  {
    // React Three Fiber renders imperatively: updating three.js objects
    // (uniforms, instance attributes, renderer info) inside useFrame and
    // effects is the documented pattern, which the React Compiler's
    // immutability check cannot distinguish from mutating React state.
    files: ['apps/web/src/world/**/*.{ts,tsx}'],
    rules: { 'react-hooks/immutability': 'off' },
  },
  {
    files: [
      'apps/server/**/*.{ts,mjs}',
      'packages/**/*.ts',
      '*.{js,mjs,ts}',
      'apps/web/*.ts',
      'scripts/**/*.mjs',
      'packaging/**/*.js',
      'e2e/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  prettier,
);
