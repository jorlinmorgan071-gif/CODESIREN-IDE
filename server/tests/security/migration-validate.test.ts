// tests/security/migration-validate.test.ts
//
// Phase C Agent 3 — validateMigrationSql() tests.
//
// Per directive Section 2: every blocked pattern needs a REJECTS test;
// every allowed pattern needs a false-positive test proving it's NOT blocked.
//
// Rules under test:
//   1. Hard-block DROP DATABASE (always)
//   2. Hard-block DROP TABLE without IF EXISTS
//   3. Hard-block bare TRUNCATE unless marker comment present
//   4. Require ALTER TABLE ADD COLUMN to use IF NOT EXISTS
//   5. Require ALTER TABLE DROP COLUMN to use IF EXISTS

import { describe, it, expect } from 'vitest';
import { validateMigrationSql, TRUNCATE_MARKER } from '../../src/agents/_shared/migration-validate.js';

describe('Phase C Agent 3 — validateMigrationSql()', () => {
  // ── Rule 1: DROP DATABASE ───────────────────────────────────────────
  describe('Rule 1: DROP DATABASE', () => {
    it('REJECTS: DROP DATABASE', () => {
      const result = validateMigrationSql('DROP DATABASE mydb;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('DROP DATABASE'))).toBe(true);
    });

    it('REJECTS: DROP DATABASE IF EXISTS (still blocked — no exceptions)', () => {
      const result = validateMigrationSql('DROP DATABASE IF EXISTS mydb;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('DROP DATABASE'))).toBe(true);
    });

    it('FALSE-POSITIVE: CREATE DATABASE is allowed', () => {
      const result = validateMigrationSql('CREATE DATABASE mydb;');
      expect(result.valid).toBe(true);
    });

    it('FALSE-POSITIVE: comment mentioning DROP DATABASE is allowed', () => {
      const result = validateMigrationSql('-- This migration does NOT drop database\nCREATE TABLE IF NOT EXISTS x (id INT);');
      expect(result.valid).toBe(true);
    });
  });

  // ── Rule 2: DROP TABLE without IF EXISTS ────────────────────────────
  describe('Rule 2: DROP TABLE without IF EXISTS', () => {
    it('REJECTS: DROP TABLE without IF EXISTS', () => {
      const result = validateMigrationSql('DROP TABLE old_data;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('DROP TABLE without IF EXISTS'))).toBe(true);
    });

    it('FALSE-POSITIVE: DROP TABLE IF EXISTS is allowed', () => {
      const result = validateMigrationSql('DROP TABLE IF EXISTS old_data;');
      expect(result.valid).toBe(true);
    });

    it('FALSE-POSITIVE: CREATE TABLE is allowed', () => {
      const result = validateMigrationSql('CREATE TABLE IF NOT EXISTS new_data (id INT PRIMARY KEY);');
      expect(result.valid).toBe(true);
    });
  });

  // ── Rule 3: bare TRUNCATE ───────────────────────────────────────────
  describe('Rule 3: bare TRUNCATE', () => {
    it('REJECTS: bare TRUNCATE without marker', () => {
      const result = validateMigrationSql('TRUNCATE TABLE test_fixtures;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('TRUNCATE without explicit marker'))).toBe(true);
    });

    it('REJECTS: TRUNCATE without TABLE keyword, no marker', () => {
      const result = validateMigrationSql('TRUNCATE test_fixtures;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('TRUNCATE without explicit marker'))).toBe(true);
    });

    it('FALSE-POSITIVE: TRUNCATE with marker comment on preceding line is allowed', () => {
      const sql = `${TRUNCATE_MARKER}\nTRUNCATE TABLE test_fixtures;`;
      const result = validateMigrationSql(sql);
      expect(result.valid).toBe(true);
    });

    it('FALSE-POSITIVE: TRUNCATE with marker before TRUNCATE without TABLE keyword', () => {
      const sql = `${TRUNCATE_MARKER}\nTRUNCATE test_fixtures;`;
      const result = validateMigrationSql(sql);
      expect(result.valid).toBe(true);
    });

    it('REJECTS: marker not on the immediately preceding line (too far away)', () => {
      const sql = `${TRUNCATE_MARKER}\n-- some other comment\nTRUNCATE TABLE test_fixtures;`;
      const result = validateMigrationSql(sql);
      expect(result.valid).toBe(false);
    });
  });

  // ── Rule 4: ALTER TABLE ADD COLUMN IF NOT EXISTS ────────────────────
  describe('Rule 4: ALTER TABLE ADD COLUMN without IF NOT EXISTS', () => {
    it('REJECTS: ALTER TABLE ADD COLUMN without IF NOT EXISTS', () => {
      const result = validateMigrationSql('ALTER TABLE users ADD COLUMN email TEXT;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('ADD COLUMN without IF NOT EXISTS'))).toBe(true);
    });

    it('REJECTS: ALTER TABLE ADD (without COLUMN keyword) without IF NOT EXISTS', () => {
      const result = validateMigrationSql('ALTER TABLE users ADD email TEXT;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('ADD COLUMN without IF NOT EXISTS'))).toBe(true);
    });

    it('FALSE-POSITIVE: ALTER TABLE ADD COLUMN IF NOT EXISTS is allowed', () => {
      const result = validateMigrationSql('ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;');
      expect(result.valid).toBe(true);
    });

    it('FALSE-POSITIVE: ALTER TABLE ADD IF NOT EXISTS (without COLUMN keyword) is allowed', () => {
      const result = validateMigrationSql('ALTER TABLE users ADD IF NOT EXISTS email TEXT;');
      expect(result.valid).toBe(true);
    });
  });

  // ── Rule 5: ALTER TABLE DROP COLUMN IF EXISTS ───────────────────────
  describe('Rule 5: ALTER TABLE DROP COLUMN without IF EXISTS', () => {
    it('REJECTS: ALTER TABLE DROP COLUMN without IF EXISTS', () => {
      const result = validateMigrationSql('ALTER TABLE users DROP COLUMN old_email;');
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('DROP COLUMN without IF EXISTS'))).toBe(true);
    });

    it('FALSE-POSITIVE: ALTER TABLE DROP COLUMN IF EXISTS is allowed', () => {
      const result = validateMigrationSql('ALTER TABLE users DROP COLUMN IF EXISTS old_email;');
      expect(result.valid).toBe(true);
    });
  });

  // ── Combined + edge cases ───────────────────────────────────────────
  describe('combined + edge cases', () => {
    it('REJECTS: multiple violations in one script', () => {
      const sql = `
        DROP DATABASE testdb;
        DROP TABLE old_table;
        TRUNCATE TABLE data;
        ALTER TABLE users ADD COLUMN x TEXT;
      `;
      const result = validateMigrationSql(sql);
      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(4);
    });

    it('APPROVES: a clean, idempotent migration script', () => {
      const sql = `
        -- Add a tags table
        CREATE TABLE IF NOT EXISTS tags (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
        ALTER TABLE users ADD COLUMN IF NOT EXISTS favorite_tag_id UUID REFERENCES tags(id);
      `;
      const result = validateMigrationSql(sql);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('APPROVES: empty SQL', () => {
      const result = validateMigrationSql('');
      expect(result.valid).toBe(true);
    });

    it('APPROVES: comment-only SQL', () => {
      const result = validateMigrationSql('-- This migration is a no-op\n-- Just a placeholder\n');
      expect(result.valid).toBe(true);
    });

    it('returns warnings (non-blocking) for DELETE without WHERE', () => {
      const sql = 'DELETE FROM logs;';
      const result = validateMigrationSql(sql);
      expect(result.valid).toBe(true); // warning, not error
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('DELETE FROM without WHERE'))).toBe(true);
    });

    it('returns warnings (non-blocking) for UPDATE without WHERE', () => {
      const sql = 'UPDATE users SET active = false;';
      const result = validateMigrationSql(sql);
      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings.some(w => w.includes('UPDATE without WHERE'))).toBe(true);
    });
  });
});
