// app/vitest.config.ts
//
// Vitest config for the app. Used for runtime tests that need the real
// monaco-editor bundle loaded (which requires a browser-like env).
//
// The setupFiles option installs browser-API stubs (jsdom doesn't fully
// implement everything Monaco pokes at module-load time).

import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  test: {
    // Default environment: jsdom (browser-like). Individual test files
    // can override via the `// @vitest-environment` doc comment.
    environment: 'jsdom',
    // Setup files run BEFORE any test module imports.
    setupFiles: ['./tests/setup/monaco-jsdom-shim.ts'],
    // Only run the tests directory by default (don't pick up src/ files
    // that might match *.test.ts patterns accidentally).
    include: ['tests/**/*.test.ts'],
    // Suppress noise — Monaco logs a lot at module-load time.
    silent: false,
  },
});
