// vitest.config.ts
import { defineConfig } from 'vitest/config';

// Set required env vars for tests (config.ts validates on import)
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'test-secret-at-least-32-chars-long';
process.env.OLLAMA_HOST = process.env.OLLAMA_HOST ?? 'http://127.0.0.1:11434';
process.env.OLLAMA_DEFAULT_MODEL = process.env.OLLAMA_DEFAULT_MODEL ?? 'llama3.2';
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/db/migrations/**', 'src/types.ts', 'scripts/**'],
      thresholds: {
        statements: 10,
        functions: 10,
        branches: 10,
        lines: 10,
      },
    },
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
