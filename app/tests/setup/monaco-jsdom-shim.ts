// app/tests/setup/monaco-jsdom-shim.ts
//
// Vitest setup file — runs BEFORE any test module imports.
// Stubs browser APIs that jsdom doesn't fully implement but that
// Monaco's ESM bundle pokes at module-load time.
//
// This is registered in vitest.config.ts via the `setupFiles` option.

// Use a typed local reference so we don't need `any` casts throughout.
type DocumentWithCommand = Document & {
  queryCommandSupported?: (cmd: string) => boolean;
};
type NavigatorWithClipboard = Navigator & {
  clipboard?: { readText(): Promise<string>; writeText(_text: string): Promise<void> };
};

// document.queryCommandSupported is checked at module-load by Monaco's
// clipboard contrib to decide whether paste is supported. jsdom doesn't
// implement it, so we stub it.
const doc = document as DocumentWithCommand;
if (typeof document !== 'undefined' && typeof doc.queryCommandSupported !== 'function') {
  doc.queryCommandSupported = (cmd: string) => cmd === 'paste';
}

// navigator.clipboard is checked too — stub it if missing.
const nav = navigator as NavigatorWithClipboard;
if (typeof navigator !== 'undefined' && !nav.clipboard) {
  nav.clipboard = {
    readText: () => Promise.resolve(''),
    writeText: () => Promise.resolve(),
  };
}
