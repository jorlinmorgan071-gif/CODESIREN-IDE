// app/tests/lightbulb-enum.runtime.test.ts
//
// Phase B follow-up: VERIFY at runtime (not just compile-time) that
// monaco.editor.ShowLightbulbIconMode.On === 'on'.
//
// Per the user's question: "does monaco.editor.ShowLightbulbIconMode.On
// actually equal the string 'on' at runtime, or are they different values
// that just happen to both typecheck once cast through unknown? If they're
// different values, the editor might silently get the wrong lightbulb
// setting even though TypeScript is now happy."
//
// This test imports the real monaco-editor runtime (via Vite/Vitest's ESM
// pipeline, which handles the CSS imports correctly) and asserts the
// runtime equality.
//
// Browser-API stubs (document.queryCommandSupported, navigator.clipboard)
// are installed by tests/setup/monaco-jsdom-shim.ts via the Vitest
// `setupFiles` option in vitest.config.ts — they run BEFORE this module
// imports monaco-editor.
//
// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import * as monaco from 'monaco-editor';

describe('Phase B follow-up — ShowLightbulbIconMode runtime verification', () => {
  it('monaco.editor.ShowLightbulbIconMode enum is exported (sanity check)', () => {
    expect(monaco.editor).toBeDefined();
    expect(monaco.editor.ShowLightbulbIconMode).toBeDefined();
    expect(typeof monaco.editor.ShowLightbulbIconMode).toBe('object');
  });

  it('CRITICAL — ShowLightbulbIconMode.On === "on" at runtime', () => {
    const enumValue = monaco.editor.ShowLightbulbIconMode.On;
    const stringValue = 'on';

    console.log('═══ ShowLightbulbIconMode runtime verification ═══');
    console.log(`monaco.editor.ShowLightbulbIconMode.On = ${JSON.stringify(enumValue)}`);
    console.log(`string literal 'on'                    = ${JSON.stringify(stringValue)}`);
    console.log(`typeof enumValue                       = ${typeof enumValue}`);
    console.log(`typeof stringValue                     = ${typeof stringValue}`);
    console.log(`enumValue === stringValue              = ${enumValue === stringValue}`);
    console.log(`Object.is(enumValue, stringValue)      = ${Object.is(enumValue, stringValue)}`);
    console.log('');
    console.log('Full enum object:', monaco.editor.ShowLightbulbIconMode);
    console.log('');
    console.log('All enum values:');
    for (const [key, value] of Object.entries(monaco.editor.ShowLightbulbIconMode)) {
      console.log(`  ${JSON.stringify(key)} → ${JSON.stringify(value)} (typeof: ${typeof value})`);
    }

    // The actual assertion — if this fails, the CodeEditor.tsx cast
    // ('on' as unknown as ShowLightbulbIconMode) is silently broken
    // and Monaco would receive the wrong value at runtime.
    expect(enumValue).toBe(stringValue);
    expect(Object.is(enumValue, stringValue)).toBe(true);
    expect(typeof enumValue).toBe('string');
  });

  it('CRITICAL — ShowLightbulbIconMode.Off === "off" and OnCode === "onCode" (sanity for the whole enum)', () => {
    // If these don't match either, the enum is a numeric enum or a
    // const enum that got compiled away — either would mean the string
    // cast is unsafe.
    expect(monaco.editor.ShowLightbulbIconMode.Off).toBe('off');
    expect(monaco.editor.ShowLightbulbIconMode.OnCode).toBe('onCode');
    expect(monaco.editor.ShowLightbulbIconMode.On).toBe('on');
  });

  it('reverse mapping NOT present (string enum reverse-mapping stripped by minifier)', () => {
    // String enums in TypeScript normally create a reverse mapping from
    // value back to the key name (e.g. enum['on'] === 'On'). Monaco's
    // bundle has this stripped (a common minification optimization since
    // the reverse mapping is rarely used in normal code).
    //
    // This is NOT a problem for our cast — we use the FORWARD direction
    // (enum.On → 'on'), which works. This test documents the finding
    // so future readers don't expect reverse mapping to work.
    expect(monaco.editor.ShowLightbulbIconMode['on']).toBeUndefined();
    expect(monaco.editor.ShowLightbulbIconMode['off']).toBeUndefined();
    expect(monaco.editor.ShowLightbulbIconMode['onCode']).toBeUndefined();
  });

  it('all enum values are strings (not numbers, not symbols)', () => {
    // A subtle red flag would be if any enum value is a number — that
    // would indicate a numeric enum being cast incorrectly, or a mix
    // that wouldn't survive a string cast.
    for (const value of Object.values(monaco.editor.ShowLightbulbIconMode)) {
      expect(typeof value).toBe('string');
    }
  });
});
