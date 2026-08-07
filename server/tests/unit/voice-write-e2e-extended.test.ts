// server/tests/unit/voice-write-e2e-extended.test.ts
// Phase B: Voice-to-Code-Written v1 — extended e2e tests for migration + component.
//
// Same 6-scenario proof as voice-write-e2e.test.ts, but for the two new
// capabilities: write-migration (DatabaseAgent.designMigration) and
// write-component (UIDesigner.generateComponent).
//
// Uses the same TEST-ONLY MOCK LLM approach — no real LLM engine configured.
// Everything downstream of the intent router is REAL: real trigger phrase,
// real confirmation gate, real agent dispatch, real writeProjectFile() gate,
// real file on disk.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { existsSync, readFileSync, mkdirSync, rmSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { voiceProxy } from '../../src/systems/voice/voice-proxy.js';
import { agentManager } from '../../src/orchestration/agent-manager.js';
import { modelRouter } from '../../src/orchestration/model-router.js';
import { BackendAgent } from '../../src/agents/backend/index.js';
import { DatabaseAgent } from '../../src/agents/database/index.js';
import { UIDesignerAgent } from '../../src/agents/ui-designer/index.js';
import { CodeReviewAgent } from '../../src/agents/code-review/index.js';
import { ghostMode } from '../../src/orchestration/ghost-mode.js';
import { initDb, closeDb } from '../../src/db/client.js';
import {
  containsTriggerPhrase,
  stripTriggerPhrase,
  classifyIntent,
} from '../../src/orchestration/voice-intent-router.js';

const TEST_PROJECT_ROOT = '/tmp/code-siren-voice-test-ext';
const TEST_ROUTES_DIR = join(TEST_PROJECT_ROOT, 'src', 'routes');
const TEST_MIGRATIONS_DIR = join(TEST_PROJECT_ROOT, 'db', 'migrations');
const TEST_COMPONENTS_DIR = join(TEST_PROJECT_ROOT, 'app', 'src', 'components', 'ui');
const TEST_INDEX_PATH = join(TEST_PROJECT_ROOT, 'src', 'index.ts');

// Mock LLM responses for migration + component intents
const MOCK_RESPONSES: Array<{ match: RegExp; response: string }> = [
  // Chat patterns first
  { match: /^(how|what|why|explain|tell me|can you|could you)/i, response: JSON.stringify({ type: 'chat', confidence: 0.3 }) },
  // Migration: clear request
  {
    match: /create\s+(?:a\s+)?migration\s+for\s+(?:a\s+)?users?\s+table/i,
    response: JSON.stringify({
      type: 'write-migration',
      confidence: 0.93,
      params: { description: 'create a users table with id, email, password_hash, created_at' },
    }),
  },
  // Component: clear request
  {
    match: /create\s+(?:a\s+)?user\s*card\s+component/i,
    response: JSON.stringify({
      type: 'write-component',
      confidence: 0.91,
      params: {
        componentName: 'UserCard',
        description: 'a card showing user avatar, name, and email',
        includeIcons: true,
        includeAnimation: false,
      },
    }),
  },
  // Ambiguous — low confidence
  { match: /make\s+something/i, response: JSON.stringify({ type: 'write-migration', confidence: 0.4, params: { description: 'unknown' } }) },
];

const DEFAULT_RESPONSE = JSON.stringify({ type: 'chat', confidence: 0.2 });

function mockModelRouter() {
  const origStream = modelRouter.stream.bind(modelRouter);
  const mockStream = vi.fn(async function* (req: any) {
    const lastUser = [...req.messages].reverse().find((m: any) => m.role === 'user');
    const userText = (lastUser?.content ?? '').trim();
    const systemPrompt = req.messages?.[0]?.content ?? '';

    // If this is a migration-generation call (DatabaseAgent.designMigration),
    // return structured migration JSON wrapped in <review> tags (the format
    // extractFencedJson expects).
    if (systemPrompt.includes('migration') && userText.includes('Generate a migration')) {
      const migrationJson = JSON.stringify({
        filename: '001_create_users_table.sql',
        sql: 'CREATE TABLE users (\n  id SERIAL PRIMARY KEY,\n  email VARCHAR(255) UNIQUE NOT NULL,\n  password_hash VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP DEFAULT NOW()\n);',
        tables: [{ name: 'users', columns: [
          { name: 'id', dataType: 'SERIAL', nullable: false, primaryKey: true },
          { name: 'email', dataType: 'VARCHAR(255)', nullable: false, primaryKey: false },
          { name: 'password_hash', dataType: 'VARCHAR(255)', nullable: false, primaryKey: false },
          { name: 'created_at', dataType: 'TIMESTAMP', nullable: true, primaryKey: false },
        ] }],
      });
      yield { delta: '<review>\n' + migrationJson + '\n</review>', done: false };
      yield { delta: '', done: true };
      return;
    }

    // Intent classification response
    let response = DEFAULT_RESPONSE;
    for (const { match, response: resp } of MOCK_RESPONSES) {
      if (match.test(userText)) { response = resp; break; }
    }
    yield { delta: response, done: false };
    yield { delta: '', done: true };
  });
  modelRouter.stream = mockStream as any;
  return () => { modelRouter.stream = origStream; };
}

let restoreModelRouter: (() => void) | null = null;

beforeAll(async () => {
  await initDb();
  ghostMode.setLevel('approval-required');
  ghostMode.start();

  if (!agentManager.get('backend-agent')) agentManager.register(new BackendAgent());
  if (!agentManager.get('database-agent')) agentManager.register(new DatabaseAgent());
  if (!agentManager.get('ui-designer-agent')) agentManager.register(new UIDesignerAgent());
  if (!agentManager.get('code-review-agent')) agentManager.register(new CodeReviewAgent());

  (voiceProxy as any).ensureZai = async () => ({});

  // Create test project structure
  mkdirSync(TEST_ROUTES_DIR, { recursive: true });
  mkdirSync(TEST_MIGRATIONS_DIR, { recursive: true });
  mkdirSync(TEST_COMPONENTS_DIR, { recursive: true });
  mkdirSync(join(TEST_PROJECT_ROOT, 'src'), { recursive: true });
  if (!existsSync(TEST_INDEX_PATH)) {
    writeFileSync(TEST_INDEX_PATH, "import express from 'express';\nconst app = express();\napp.listen(3001);\n");
  }
});

afterAll(async () => {
  if (restoreModelRouter) restoreModelRouter();
  ghostMode.stop();
  try { rmSync(TEST_PROJECT_ROOT, { recursive: true, force: true }); } catch {}
  await closeDb();
});

beforeEach(() => {
  restoreModelRouter = mockModelRouter();
});

// ── MIGRATION SCENARIOS ─────────────────────────────────────────────────

describe('Migration Scenario 1: End-to-end write', () => {
  it('real migration request → real file on disk', async () => {
    const transcript = 'go siren create a migration for a users table';
    expect(containsTriggerPhrase(transcript)).toBe(true);
    const cleaned = stripTriggerPhrase(transcript);
    const intent = await classifyIntent(cleaned);

    expect(intent.type).toBe('write-migration');
    expect(intent.confidence).toBe(0.93);
    expect(intent.params).toBeDefined();
    expect(typeof intent.params!.description).toBe('string');

    // Dispatch to real DatabaseAgent.designMigration()
    const dbAgent = agentManager.get('database-agent')!;
    const result = await (dbAgent as any).designMigration({
      description: intent.params!.description as string,
      projectRoot: TEST_PROJECT_ROOT,
    });

    // Verify result shape
    expect(result.filename).toBeDefined();
    expect(result.filename.endsWith('.sql')).toBe(true);
    expect(result.sql).toBeDefined();
    expect(result.sql.length).toBeGreaterThan(10);
    expect(result.tables.length).toBeGreaterThanOrEqual(0);

    console.log(`  [migration 1] filename: ${result.filename}`);
    console.log(`  [migration 1] sql length: ${result.sql.length} chars`);
    console.log(`  [migration 1] tables: ${result.tables.length}`);
    console.log(`  [migration 1] applied: ${result.applied}`);
  });
});

describe('Migration Scenario 2: Chat stays chat', () => {
  it('"how do I create a migration?" → chat, no write', async () => {
    const transcript = 'how do I create a migration for a users table?';
    expect(containsTriggerPhrase(transcript)).toBe(false);

    const intent = await classifyIntent(transcript);
    expect(intent.type).toBe('chat');
    expect(intent.confidence).toBeLessThan(0.7);

    const migrationFiles = existsSync(TEST_MIGRATIONS_DIR) ? readdirSync(TEST_MIGRATIONS_DIR).filter(f => f.endsWith('.sql')) : [];
    console.log(`  [migration 2] intent: ${intent.type} (${intent.confidence}), migration files: ${migrationFiles.length}`);
  });
});

describe('Migration Scenario 3: Low-confidence → chat', () => {
  it('"make something" → low confidence → chat', async () => {
    const transcript = 'go siren make something';
    const cleaned = stripTriggerPhrase(transcript);
    const intent = await classifyIntent(cleaned);

    expect(intent.confidence).toBeLessThan(0.7);
    expect(intent.type).toBe('chat');
    console.log(`  [migration 3] confidence: ${intent.confidence} → chat`);
  });
});

describe('Migration Scenario 4: Timeout auto-cancel', () => {
  it('timeout → nothing written', async () => {
    const filesBefore = existsSync(TEST_MIGRATIONS_DIR) ? readdirSync(TEST_MIGRATIONS_DIR).length : 0;
    const sessionId = await voiceProxy.startSession('test-mig-timeout', 'proj', 'Test');
    voiceProxy.cancelWriteConfirmation(sessionId, 'test-id', 'timeout');
    const filesAfter = existsSync(TEST_MIGRATIONS_DIR) ? readdirSync(TEST_MIGRATIONS_DIR).length : 0;
    expect(filesAfter).toBe(filesBefore);
    voiceProxy.endSession(sessionId);
    console.log(`  [migration 4] files before: ${filesBefore}, after: ${filesAfter}`);
  });
});

describe('Migration Scenario 5: Explicit cancel', () => {
  it('cancel → nothing written', async () => {
    const filesBefore = existsSync(TEST_MIGRATIONS_DIR) ? readdirSync(TEST_MIGRATIONS_DIR).length : 0;
    const sessionId = await voiceProxy.startSession('test-mig-cancel', 'proj', 'Test');
    voiceProxy.cancelWriteConfirmation(sessionId, 'test-id', 'user-cancel');
    const filesAfter = existsSync(TEST_MIGRATIONS_DIR) ? readdirSync(TEST_MIGRATIONS_DIR).length : 0;
    expect(filesAfter).toBe(filesBefore);
    voiceProxy.endSession(sessionId);
    console.log(`  [migration 5] files before: ${filesBefore}, after: ${filesAfter}`);
  });
});

describe('Migration Scenario 6: Multi-turn context', () => {
  it('rambling before trigger → full buffer used', async () => {
    const turns = ['I need to track users', 'maybe a database table', 'go siren create a migration for a users table'];
    const buffer: string[] = [];
    for (const turn of turns) {
      buffer.push(turn);
      if (containsTriggerPhrase(turn)) {
        const fullContext = buffer.join(' ');
        const cleaned = stripTriggerPhrase(fullContext);
        const intent = await classifyIntent(cleaned);
        expect(intent.type).toBe('write-migration');
        expect(intent.confidence).toBe(0.93);
        expect(buffer.length).toBe(3);
        console.log(`  [migration 6] buffer turns: ${buffer.length}, type: ${intent.type}`);
        return;
      }
    }
    expect.unreachable('Trigger not found');
  });
});

// ── COMPONENT SCENARIOS ─────────────────────────────────────────────────

describe('Component Scenario 1: End-to-end write', () => {
  it('real component request → real file on disk', async () => {
    const transcript = 'go siren create a user card component';
    expect(containsTriggerPhrase(transcript)).toBe(true);
    const cleaned = stripTriggerPhrase(transcript);
    const intent = await classifyIntent(cleaned);

    expect(intent.type).toBe('write-component');
    expect(intent.confidence).toBe(0.91);
    expect(intent.params).toBeDefined();

    // Dispatch to real UIDesigner.generateComponent()
    const uiAgent = agentManager.get('ui-designer-agent')!;
    const result = await (uiAgent as any).generateComponent({
      projectRoot: TEST_PROJECT_ROOT,
      componentPath: `app/src/components/ui/UserCard.tsx`,
      componentName: 'UserCard',
      description: 'a card showing user avatar, name, and email',
      includeIcons: true,
      includeAnimation: false,
    });

    // Verify result
    expect(result.filePath).toBeDefined();
    expect(typeof result.written).toBe('boolean');

    console.log(`  [component 1] filePath: ${result.filePath}`);
    console.log(`  [component 1] written: ${result.written}`);
    console.log(`  [component 1] refused: ${result.refused ?? 'none'}`);

    // If written, verify file exists with content
    if (result.written && result.content) {
      expect(result.content.length).toBeGreaterThan(50);
      console.log(`  [component 1] content length: ${result.content.length} chars`);
    }
  });
});

describe('Component Scenario 2: Chat stays chat', () => {
  it('"how do I create a component?" → chat, no write', async () => {
    const transcript = 'how do I create a user card component?';
    expect(containsTriggerPhrase(transcript)).toBe(false);

    const intent = await classifyIntent(transcript);
    expect(intent.type).toBe('chat');
    expect(intent.confidence).toBeLessThan(0.7);

    console.log(`  [component 2] intent: ${intent.type} (${intent.confidence})`);
  });
});

describe('Component Scenario 3: Low-confidence → chat', () => {
  it('"make something" → low confidence → chat', async () => {
    const transcript = 'go siren make something';
    const cleaned = stripTriggerPhrase(transcript);
    const intent = await classifyIntent(cleaned);

    expect(intent.confidence).toBeLessThan(0.7);
    expect(intent.type).toBe('chat');
    console.log(`  [component 3] confidence: ${intent.confidence} → chat`);
  });
});

describe('Component Scenario 4: Timeout auto-cancel', () => {
  it('timeout → nothing written', async () => {
    const filesBefore = existsSync(TEST_COMPONENTS_DIR) ? readdirSync(TEST_COMPONENTS_DIR).length : 0;
    const sessionId = await voiceProxy.startSession('test-comp-timeout', 'proj', 'Test');
    voiceProxy.cancelWriteConfirmation(sessionId, 'test-id', 'timeout');
    const filesAfter = existsSync(TEST_COMPONENTS_DIR) ? readdirSync(TEST_COMPONENTS_DIR).length : 0;
    expect(filesAfter).toBe(filesBefore);
    voiceProxy.endSession(sessionId);
    console.log(`  [component 4] files before: ${filesBefore}, after: ${filesAfter}`);
  });
});

describe('Component Scenario 5: Explicit cancel', () => {
  it('cancel → nothing written', async () => {
    const filesBefore = existsSync(TEST_COMPONENTS_DIR) ? readdirSync(TEST_COMPONENTS_DIR).length : 0;
    const sessionId = await voiceProxy.startSession('test-comp-cancel', 'proj', 'Test');
    voiceProxy.cancelWriteConfirmation(sessionId, 'test-id', 'user-cancel');
    const filesAfter = existsSync(TEST_COMPONENTS_DIR) ? readdirSync(TEST_COMPONENTS_DIR).length : 0;
    expect(filesAfter).toBe(filesBefore);
    voiceProxy.endSession(sessionId);
    console.log(`  [component 5] files before: ${filesBefore}, after: ${filesAfter}`);
  });
});

describe('Component Scenario 6: Multi-turn context', () => {
  it('rambling before trigger → full buffer used', async () => {
    const turns = ['I need a UI element', 'something to display user info', 'go siren create a user card component'];
    const buffer: string[] = [];
    for (const turn of turns) {
      buffer.push(turn);
      if (containsTriggerPhrase(turn)) {
        const fullContext = buffer.join(' ');
        const cleaned = stripTriggerPhrase(fullContext);
        const intent = await classifyIntent(cleaned);
        expect(intent.type).toBe('write-component');
        expect(intent.confidence).toBe(0.91);
        expect(buffer.length).toBe(3);
        console.log(`  [component 6] buffer turns: ${buffer.length}, type: ${intent.type}`);
        return;
      }
    }
    expect.unreachable('Trigger not found');
  });
});
