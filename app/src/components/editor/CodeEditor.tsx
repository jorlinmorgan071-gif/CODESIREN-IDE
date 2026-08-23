import { useCallback, useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { useApp } from '@/store/AppContext';
import { X, FilePlus2, Files, Keyboard, Wand2 } from 'lucide-react';

const languageMap: Record<string, string> = {
  typescript: 'typescript',
  javascript: 'javascript',
  css: 'css',
  json: 'json',
  markdown: 'markdown',
  html: 'html',
  plaintext: 'plaintext',
};

// ── AI completion debounce state (Phase A Step 6) ────────────────────────
// Module-scoped so the cancel-token pattern survives re-mounts of the
// editor component. If a new completion request comes in before the
// previous one resolves, the previous fetch's result is dropped.
let aiCompletionToken = 0;
let aiCompletionTimer: ReturnType<typeof setTimeout> | null = null;
let aiCompletionAbort: AbortController | null = null;

// ── Phase 2: Live editor content access ────────────────────────────────
// Module-scoped ref to the active Monaco editor instance. This lets
// ChatPanel read the current in-memory buffer (including unsaved edits)
// without needing a direct ref into CodeEditor.
// The ref is set in handleEditorMount and cleared on unmount.
let activeEditorRef: MonacoType.editor.IStandaloneCodeEditor | null = null;

/**
 * Get the live (unsaved) content of the active editor model.
 * Returns null if no editor is mounted or no model is active.
 * This is the in-memory buffer — it includes unsaved user edits
 * that haven't been written to disk yet.
 */
// eslint-disable-next-line react-refresh/only-export-components
export function getActiveEditorContent(): string | null {
  if (!activeEditorRef) return null;
  const model = activeEditorRef.getModel();
  if (!model) return null;
  return model.getValue();
}

/**
 * Get the active selection from the Monaco editor.
 * Returns null if no editor, no model, or no selection (empty caret).
 * The selection is read from Monaco's in-memory state — it includes
 * unsaved edits because it reads from the live model buffer.
 */
export interface EditorSelection {
  text: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

// eslint-disable-next-line react-refresh/only-export-components
export function getActiveEditorSelection(): EditorSelection | null {
  if (!activeEditorRef) return null;
  const model = activeEditorRef.getModel();
  if (!model) return null;
  const selection = activeEditorRef.getSelection();
  if (!selection || selection.isEmpty()) return null;
  const text = model.getValueInRange(selection);
  if (!text) return null;
  return {
    text,
    startLine: selection.startLineNumber,
    startColumn: selection.startColumn,
    endLine: selection.endLineNumber,
    endColumn: selection.endColumn,
  };
}

export function CodeEditor() {
  const { state, closeTab, setActiveFile, updateProblems } = useApp();
  const [mounted] = useState(true);
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; }, [state]);

  // Bug F fix — ResizeObserver on the tab bar's parent flex container.
  const tabBarContainerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  useEffect(() => {
    const el = tabBarContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  void containerWidth;

  // Phase A — store the Monaco instance + editor instance in refs so the
  // multi-file model sync effect (Step 3) and the Format button (Step 7)
  // can access them.
  const monacoRef = useRef<typeof MonacoType | null>(null);
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);

  // ── Phase A Step 1+2+5+6: editor mount handler ────────────────────────
  // Configures TypeScript/JavaScript IntelliSense, React types, diagnostics
  // wiring, AI completion provider, and the format keyboard shortcut.
  const handleEditorMount = useCallback(
    (_editor: MonacoType.editor.IStandaloneCodeEditor, monaco: typeof MonacoType) => {
      editorRef.current = _editor;
      monacoRef.current = monaco;
      activeEditorRef = _editor;  // Phase 2: expose for getActiveEditorContent()

      // ── Custom dark theme (unchanged from prior phases) ──────────────
      monaco.editor.defineTheme('zero-two-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [
          { token: 'comment', foreground: '5A5A72', fontStyle: 'italic' },
          { token: 'keyword', foreground: 'EE1C1C' },
          { token: 'identifier', foreground: 'C8C8DC' },
          { token: 'string', foreground: '22C55E' },
          { token: 'number', foreground: 'F59E0B' },
          { token: 'type', foreground: '3B82F6' },
          { token: 'function', foreground: 'A855F7' },
          { token: 'tag', foreground: 'EE1C1C' },
          { token: 'attribute.name', foreground: 'F59E0B' },
          { token: 'attribute.value', foreground: '22C55E' },
        ],
        colors: {
          'editor.background': '#07070B',
          'editor.foreground': '#C8C8DC',
          'editor.lineHighlightBackground': '#0E0E14',
          'editor.selectionBackground': 'rgba(238, 28, 28, 0.2)',
          'editor.inactiveSelectionBackground': 'rgba(238, 28, 28, 0.1)',
          'editorCursor.foreground': '#EE1C1C',
          'editorLineNumber.foreground': '#5A5A72',
          'editorLineNumber.activeForeground': '#8A8AA0',
          'editorIndentGuide.background': '#1E1E2A',
          'editorIndentGuide.activeBackground': '#2A2A3C',
          'editorWhitespace.foreground': '#1E1E2A',
          'editorWidget.background': '#15151E',
          'editorWidget.border': '#2A2A3C',
          'editor.findMatchBackground': 'rgba(238, 28, 28, 0.3)',
          'editor.findMatchHighlightBackground': 'rgba(238, 28, 28, 0.15)',
          'editorHoverWidget.background': '#15151E',
          'editorHoverWidget.border': '#2A2A3C',
          'minimap.background': '#0A0A10',
          'scrollbarSlider.background': '#1E1E2A',
          'scrollbarSlider.hoverBackground': '#2A2A3C',
          'scrollbarSlider.activeBackground': '#3A3A4C',
          'editorGutter.background': '#07070B',
          'editorGutter.modifiedBackground': '#EE1C1C',
          'editorGutter.addedBackground': '#22C55E',
          'editorGutter.deletedBackground': '#6A0808',
          'breadcrumb.background': '#0A0A10',
          'breadcrumb.foreground': '#8A8AA0',
          'breadcrumb.activeSelectionForeground': '#C8C8DC',
        },
      });
      monaco.editor.setTheme('zero-two-dark');

      // ── Phase A Step 1: TypeScript compiler options ──────────────────
      // Configure Monaco's built-in TypeScript worker. Without this,
      // quickSuggestions:true produces nothing — the worker isn't
      // configured to do semantic analysis.
      //
      // NOTE: monaco-editor v0.55+ deprecates `monaco.languages.typescript`
      // in favor of the new top-level `monaco.typescript` namespace. The
      // old namespace is typed as `{ deprecated: true }` and produces
      // TS2339 errors. The new namespace exposes the same API surface
      // (typescriptDefaults, javascriptDefaults, ScriptTarget, etc.).
      const ts = monaco.typescript;
      ts.typescriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ESNext,
        allowNonTsExtensions: true,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        module: ts.ModuleKind.CommonJS,
        noEmit: true,
        esModuleInterop: true,
        jsx: ts.JsxEmit.React,
        allowJs: true,
        typeRoots: ['node_modules/@types'],
        // strict: false — don't spam errors on demo files. The user can
        // opt in to strict mode per-project by changing this later.
        strict: false,
      });

      // Same for JavaScript — same worker, different defaults.
      ts.javascriptDefaults.setCompilerOptions({
        target: ts.ScriptTarget.ESNext,
        allowNonTsExtensions: true,
        allowJs: true,
        checkJs: true,
      });

      // Enable ALL diagnostics — both semantic (type errors) and syntax
      // (parse errors). The user wants red squiggles on real type errors.
      ts.typescriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });
      ts.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: false,
        noSyntaxValidation: false,
      });

      // ── Phase A Step 2: React type definitions ───────────────────────
      // Fetch @types/react from unpkg and inject via addExtraLib so JSX
      // doesn't produce "Cannot find module 'react'" errors. Wrapped in
      // try/catch — types are a nice-to-have, not required for IntelliSense
      // to work on plain TS files. If offline, skip silently.
      (async () => {
        try {
          const reactTypes = await fetch(
            'https://unpkg.com/@types/react@18/index.d.ts'
          ).then((r) => {
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return r.text();
          });
          ts.typescriptDefaults.addExtraLib(
            reactTypes,
            'file:///node_modules/@types/react/index.d.ts'
          );
          console.log('[editor] React types loaded — JSX IntelliSense active');
        } catch (err) {
          console.warn(
            '[editor] React types fetch failed (offline?) — JSX IntelliSense will be limited:',
            err instanceof Error ? err.message : err
          );
        }
      })();

      // ── Phase A Step 5: Diagnostics wiring ───────────────────────────
      // Listen for marker changes on the active model and dispatch them
      // to AppContext as UPDATE_PROBLEMS. The Problems tab in Terminal.tsx
      // reads state.problems and renders them.
      const onMarkersChanged = monaco.editor.onDidChangeMarkers(([resource]) => {
        const model = _editor.getModel();
        if (!model) return;
        if (resource.toString() !== model.uri.toString()) return;
        const markers = monaco.editor.getModelMarkers({ resource });
        // Monaco MarkerSeverity: Error=8, Warning=4, Info=2, Hint=1.
        // Build the problem list with explicit literal-union typing so
        // TypeScript accepts the severity value (the conditional would
        // otherwise widen to `string`, which isn't assignable to
        // Problem['severity'] = 'error' | 'warning' | 'info').
        const problems: import('@/types').Problem[] = markers.map((m) => ({
          file: model.uri.path.split('/').pop() ?? model.uri.path,
          line: m.startLineNumber,
          column: m.startColumn,
          message: m.message,
          severity:
            m.severity === monaco.MarkerSeverity.Error
              ? 'error'
              : m.severity === monaco.MarkerSeverity.Warning
                ? 'warning'
                : 'info',
        }));
        updateProblems(problems);
      });
      // Store the disposable so we can clean it up on unmount.
      _editor.onDidDispose(() => onMarkersChanged.dispose());

      // ── Phase A Step 6: AI inline completion provider ────────────────
      // CHIMERA Inline Completion — switched from registerCompletionItemProvider
      // (dropdown widget) to registerInlineCompletionsProvider (Copilot-style
      // ghost text). The server endpoint now takes { prefix, suffix } and uses
      // FIM prompting (labeled prefix/suffix + <CURSOR/> marker) instead of a
      // single blended context string.
      //
      // 300ms debounce + real AbortController: if a new completion request
      // comes in before the previous one resolves, the previous fetch is
      // actually aborted (not just discarded client-side), saving server
      // resources. Monaco's own CancellationToken is ALSO wired — if Monaco
      // decides to cancel (user typed more, scrolled, etc.), we abort too.
      const buildInlineCompletions = (
        model: MonacoType.editor.ITextModel,
        position: MonacoType.Position,
        monacoToken: MonacoType.CancellationToken
      ): Promise<MonacoType.languages.InlineCompletions | undefined> => {
        return new Promise((resolve) => {
          // Build prefix/suffix from the actual cursor position.
          //   prefix = 10 lines above cursor + current line up to cursor column
          //   suffix = current line after cursor column + 5 lines below
          // Same line-count windows as the previous build (10 above / 5 below).
          const prefixStartLine = Math.max(1, position.lineNumber - 10);
          const prefix = model.getValueInRange({
            startLineNumber: prefixStartLine,
            startColumn: 1,
            endLineNumber: position.lineNumber,
            endColumn: position.column,
          });
          const suffixEndLine = Math.min(
            model.getLineCount(),
            position.lineNumber + 5
          );
          const suffix = model.getValueInRange({
            startLineNumber: position.lineNumber,
            startColumn: position.column,
            endLineNumber: suffixEndLine,
            endColumn: model.getLineMaxColumn(suffixEndLine),
          });

          // Skip if there's nothing to complete on (brand-new empty file).
          // Unlike the old dropdown provider, we DON'T bail on short words —
          // ghost text is useful even at the start of an empty line.
          if (!prefix.trim() && !suffix.trim()) {
            resolve(undefined);
            return;
          }

          // Cancel any pending request + clear its debounce timer.
          if (aiCompletionTimer) {
            clearTimeout(aiCompletionTimer);
          }
          // Abort the previous fetch if one is in-flight
          if (aiCompletionAbort) {
            aiCompletionAbort.abort();
          }
          const myToken = ++aiCompletionToken;
          const myAbort = new AbortController();
          aiCompletionAbort = myAbort;

          // Also wire Monaco's CancellationToken — if Monaco cancels (user
          // typed more, scrolled, position changed), abort our fetch too.
          // This is in addition to our own supersede pattern.
          const monacoCancelSub = monacoToken.onCancellationRequested(() => {
            myAbort.abort();
          });

          const fireRequest = async () => {
            // If Monaco already cancelled during the debounce window, bail.
            if (monacoToken.isCancellationRequested) {
              monacoCancelSub.dispose();
              resolve(undefined);
              return;
            }
            try {
              const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api';
              const { getToken } = await import('@/lib/auth');
              const token = getToken() ?? '';
              const tStart = Date.now();
              const res = await fetch(`${API_BASE}/orchestrator/complete`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Authorization': `Bearer ${token}`,
                },
                body: JSON.stringify({ prefix, suffix }),
                signal: myAbort.signal,
              });

              if (!res.ok) {
                if (myToken === aiCompletionToken) {
                  resolve(undefined);
                }
                return;
              }

              const data = await res.json() as { text: string };
              const elapsed = Date.now() - tStart;

              // Superseded by a newer request — drop our result
              if (myToken !== aiCompletionToken) {
                return;
              }

              if (!data.text || data.text.length === 0) {
                resolve(undefined);
                return;
              }

              // Filter out any markdown fences or backticks the model might add
              // despite the system prompt telling it not to.
              const cleanText = data.text
                .replace(/^```[\w]*\n?/g, '')
                .replace(/\n?```$/g, '')
                .trim();

              if (!cleanText) {
                resolve(undefined);
                return;
              }

              console.log(
                `[editor] AI inline completion: "${cleanText.slice(0, 60)}..." (${elapsed}ms)`
              );

              // InlineCompletions response shape — different from the old
              // CompletionList. Each item has insertText + range. The range
              // is a zero-width range at the cursor position so Monaco
              // inserts the text exactly where the cursor is (ghost text).
              // Per Monaco docs: range must begin and end on the same line.
              const range = {
                startLineNumber: position.lineNumber,
                endLineNumber: position.lineNumber,
                startColumn: position.column,
                endColumn: position.column,
              };

              resolve({
                items: [{
                  insertText: cleanText,
                  range,
                  completeBracketPairs: true,
                }],
              });
            } catch (err: unknown) {
              // AbortError = superseded by a newer request, OR Monaco cancel —
              // not an error, just resolve undefined.
              const errName = err instanceof Error ? err.name : '';
              if (errName === 'AbortError') {
                if (myToken === aiCompletionToken) {
                  resolve(undefined);
                }
                return;
              }
              const errMsg = err instanceof Error ? err.message : String(err);
              console.warn('[editor] AI inline completion failed:', errMsg);
              if (myToken === aiCompletionToken) {
                resolve(undefined);
              }
            }
          };

          // 300ms debounce — only fire after the user pauses typing.
          aiCompletionTimer = setTimeout(fireRequest, 300);
        });
      };

      const inlineCompletionProvider: MonacoType.languages.InlineCompletionsProvider = {
        provideInlineCompletions: (
          model: MonacoType.editor.ITextModel,
          position: MonacoType.Position,
          context: MonacoType.languages.InlineCompletionContext,
          token: MonacoType.CancellationToken
        ): Promise<MonacoType.languages.InlineCompletions | undefined> => {
          // context is currently unused — we always trigger regardless of
          // InlineCompletionTriggerKind (Automatic vs Invoke). The debounce
          // + cancellation pattern handles over-firing.
          void context;
          return buildInlineCompletions(model, position, token);
        },
        // Required by the interface — no resources to free, the abort
        // controller + timer are module-scoped and self-managing.
        disposeInlineCompletions: () => {},
      };
      monaco.languages.registerInlineCompletionsProvider('typescript', inlineCompletionProvider);
      monaco.languages.registerInlineCompletionsProvider('javascript', inlineCompletionProvider);

      // ── Phase A Step 7: Format on demand (Ctrl+Shift+F) ─────────────
      _editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
        () => {
          _editor.getAction('editor.action.formatDocument')?.run();
        }
      );

      // ── Phase B: Editor Actions — "Explain" context menu ─────────────
      // Right-click in the editor → "Explain Selected Code" → reads the
      // selection, dispatches a custom event that InlineAI listens for.
      // Also listens for 'code-siren:request-selection' so the InlineAI
      // panel's Explain button can request the current selection.
      _editor.addAction({
        id: 'code-siren-explain',
        label: 'Explain Selected Code',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.5,
        keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyE],
        run: async (ed: MonacoType.editor.ICodeEditor) => {
          const selection = ed.getSelection();
          if (!selection || selection.isEmpty()) return;
          const model = ed.getModel();
          if (!model) return;
          const selectedText = model.getValueInRange(selection);
          if (!selectedText.trim()) return;
          const language = model.getLanguageId?.() ?? undefined;
          window.dispatchEvent(new CustomEvent('code-siren:explain', {
            detail: { code: selectedText, language },
          }));
        },
      });

      // Listen for request-selection from the InlineAI Explain button
      const requestSelectionHandler = () => {
        const selection = _editor.getSelection();
        if (!selection || selection.isEmpty()) return;
        const model = _editor.getModel();
        if (!model) return;
        const selectedText = model.getValueInRange(selection);
        if (!selectedText.trim()) return;
        const language = model.getLanguageId?.() ?? undefined;
        window.dispatchEvent(new CustomEvent('code-siren:explain', {
          detail: { code: selectedText, language },
        }));
      };
      window.addEventListener('code-siren:request-selection', requestSelectionHandler);

      // Listen for request-selection-for-edit from InlineAI edit-family buttons
      // (refactor/document/optimize/convert). Sends back code + language + selection range.
      const requestSelectionForEditHandler = (e: Event) => {
        const detail = (e as CustomEvent).detail as { mode: string };
        if (!detail?.mode) return;
        const selection = _editor.getSelection();
        if (!selection || selection.isEmpty()) return;
        const model = _editor.getModel();
        if (!model) return;
        const selectedText = model.getValueInRange(selection);
        if (!selectedText.trim()) return;
        const language = model.getLanguageId?.() ?? undefined;
        const activeTab = stateRef.current.editorTabs.find((tab) => tab.isActive);
        window.dispatchEvent(new CustomEvent('code-siren:explain', {
          detail: {
            code: selectedText,
            language,
            editMode: detail.mode,
            fileId: activeTab?.fileId,
            path: activeTab?.workspacePath,
            editorContent: model.getValue(),
            selectionRange: {
              startLineNumber: selection.startLineNumber,
              startColumn: selection.startColumn,
              endLineNumber: selection.endLineNumber,
              endColumn: selection.endColumn,
            },
          },
        }));
      };
      window.addEventListener('code-siren:request-selection-for-edit', requestSelectionForEditHandler);

      _editor.onDidDispose(() => {
        window.removeEventListener('code-siren:request-selection', requestSelectionHandler);
        window.removeEventListener('code-siren:request-selection-for-edit', requestSelectionForEditHandler);
        activeEditorRef = null;  // Phase 2: clear on dispose
      });

      // ── Phase A Step 3: Multi-file model sync (initial pass) ────────
      // The full sync logic runs in a separate useEffect below that
      // watches state.editorTabs + state.fileContents. Here we just
      // register the active file as a model so IntelliSense can resolve
      // it immediately on mount.
      const activeTab = state.editorTabs.find((t) => t.isActive);
      if (activeTab) {
        const content = state.fileContents[activeTab.fileId] ?? '';
        const lang = languageMap[activeTab.language] ?? 'plaintext';
        const uri = monaco.Uri.parse(`file:///${activeTab.workspacePath ?? `demo/${activeTab.fileId}`}`);
        let model = monaco.editor.getModel(uri);
        if (!model) {
          model = monaco.editor.createModel(content, lang, uri);
        } else if (model.getValue() !== content) {
          model.setValue(content);
        }
        _editor.setModel(model);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ── Phase A Step 3: Multi-file model sync ──────────────────────────────
  // Whenever the open tabs or their contents change, register/update
  // Monaco models for ALL open files (not just the active one). This is
  // what makes imports resolve across files — Monaco's TS worker reads
  // all registered models when resolving import statements.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    const editor = editorRef.current;
    if (!editor) return;

    const activeTab = state.editorTabs.find((t) => t.isActive);
    if (!activeTab) return;

    // Ensure the active tab's model exists + is bound to the editor.
    const activeContent = state.fileContents[activeTab.fileId] ?? '';
    const activeLang = languageMap[activeTab.language] ?? 'plaintext';
    const activeUri = monaco.Uri.parse(`file:///${activeTab.workspacePath ?? `demo/${activeTab.fileId}`}`);
    let activeModel = monaco.editor.getModel(activeUri);
    if (!activeModel) {
      activeModel = monaco.editor.createModel(activeContent, activeLang, activeUri);
    } else if (activeModel.getValue() !== activeContent) {
      activeModel.setValue(activeContent);
    }
    // Only switch the editor's model if it's not already the active one —
    // avoids an unnecessary cursor reset on every keystroke.
    if (editor.getModel()?.uri.toString() !== activeUri.toString()) {
      editor.setModel(activeModel);
    }

    // Register models for ALL other open tabs too (so imports resolve).
    for (const tab of state.editorTabs) {
      if (tab.fileId === activeTab.fileId) continue;
      const content = state.fileContents[tab.fileId] ?? '';
      if (!content) continue;
      const lang = languageMap[tab.language] ?? 'plaintext';
      const uri = monaco.Uri.parse(`file:///${tab.workspacePath ?? `demo/${tab.fileId}`}`);
      const existingModel = monaco.editor.getModel(uri);
      if (!existingModel) {
        monaco.editor.createModel(content, lang, uri);
      } else if (existingModel.getValue() !== content) {
        existingModel.setValue(content);
      }
    }

    // Dispose models for tabs that have been closed. Walk all models and
    // remove any whose URI doesn't correspond to a currently-open tab.
    const openModelPaths = new Set(state.editorTabs.map((tab) => `/${tab.workspacePath ?? `demo/${tab.fileId}`}`));
    for (const model of monaco.editor.getModels()) {
      if (!openModelPaths.has(model.uri.path)) {
        // Don't dispose the active model — that would blank the editor.
        if (model.uri.toString() !== activeUri.toString()) {
          model.dispose();
        }
      }
    }
  }, [state.editorTabs, state.fileContents]);

  // ── Phase A Step 7: Format button handler ──────────────────────────────
  const handleFormat = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.getAction('editor.action.formatDocument')?.run();
  }, []);

  const activeTab = state.editorTabs.find((t) => t.isActive);
  const content = activeTab ? state.fileContents[activeTab.fileId] || '' : '';
  const language = activeTab ? languageMap[activeTab.language] || 'plaintext' : 'plaintext';

  return (
    <div className="flex-1 flex flex-col overflow-hidden zt-grid-bg">
      {/* Tab bar — Bug F fix: overflow-x:auto with custom thin scrollbar,
          tabs use min-width:0 + flex-1 + truncate so they compress
          gracefully when the parent flex container shrinks (sidebars
          open/close). The ResizeObserver above (containerWidth state)
          forces a re-render whenever the parent width changes so the
          truncate/ellipsis re-applies at the new available width. */}
      <div
        ref={tabBarContainerRef}
        className="flex items-center overflow-x-auto zt-tabbar-scroll"
        style={{
          backgroundColor: '#0A0A10',
          borderBottom: '1px solid var(--border-subtle)',
          minHeight: '36px',
        }}
      >
        {state.editorTabs.map((tab) => (
          <button
            key={tab.fileId}
            className="flex items-center gap-1.5 px-3 py-2 text-[12px] min-w-[40px] max-w-[200px] flex-1 min-w-0 transition-colors relative group"
            style={{
              backgroundColor: tab.isActive ? '#07070B' : 'transparent',
              color: tab.isActive ? 'var(--bright-silver)' : 'var(--steel-silver)',
              borderRight: '1px solid var(--border-subtle)',
              flexShrink: 1,
              overflow: 'hidden',
            }}
            onClick={() => setActiveFile(tab.fileId)}
          >
            {tab.isActive && (
              <div
                className="absolute top-0 left-0 right-0 h-0.5"
                style={{ backgroundColor: 'var(--siren-red)' }}
              />
            )}
            <span className="truncate flex-1 text-left">{tab.fileName}</span>
            {tab.isModified && (
              <div className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ backgroundColor: 'var(--siren-red)' }} />
            )}
            <span
              className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-white/10"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(tab.fileId);
              }}
            >
              <X className="w-3 h-3" />
            </span>
          </button>
        ))}

        {state.editorTabs.length === 0 && (
          <div className="flex-1" />
        )}
      </div>

      {/* Breadcrumbs + Format button (Phase A Step 7) */}
      {activeTab && (
        <div
          className="flex items-center gap-1 px-3 py-1 text-[11px]"
          style={{
            backgroundColor: '#0A0A10',
            color: 'var(--steel-silver)',
            borderBottom: '1px solid var(--border-subtle)',
          }}
        >
          <span>src</span>
          <span style={{ color: 'var(--muted-silver)' }}>/</span>
          <span>{activeTab.fileName}</span>
          {/* Format button — right-aligned, small icon.
              Shortcut: Ctrl+Shift+F (registered in handleEditorMount). */}
          <button
            onClick={handleFormat}
            className="ml-auto flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors hover:bg-white/5"
            style={{ color: 'var(--steel-silver)' }}
            title="Format document (Ctrl+Shift+F)"
          >
            <Wand2 className="w-3 h-3" />
            Format
          </button>
        </div>
      )}

      {/* Editor */}
      <div className="flex-1 overflow-hidden">
        {activeTab && mounted && content ? (
          <Editor
            height="100%"
            language={language}
            value={content}
            theme="zero-two-dark"
            onMount={handleEditorMount}
            options={{
              // ── Existing options ──────────────────────────────────
              minimap: { enabled: true, scale: 1, side: 'right' },
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
              lineNumbers: 'on',
              roundedSelection: false,
              scrollBeyondLastLine: false,
              readOnly: false,
              automaticLayout: true,
              padding: { top: 12 },
              folding: true,
              renderLineHighlight: 'line',
              matchBrackets: 'always',
              tabSize: 2,
              insertSpaces: true,
              wordWrap: 'on',
              quickSuggestions: true,
              suggestOnTriggerCharacters: true,
              formatOnPaste: true,
              formatOnType: true,
              // ── Phase A Step 4: Enhanced editor options ───────────
              // All built into Monaco — no LSP needed.
              suggestSelection: 'first',
              parameterHints: { enabled: true },
              inlineSuggest: { enabled: true },
              hover: { enabled: true, delay: 300 },
              codeLens: false,  // too noisy for now
              foldingStrategy: 'indentation',
              showUnused: true,
              showDeprecated: true,
              // ShowLightbulbIconMode is a string enum (not a string literal
              // union) in monaco-editor v0.55+. The enum's underlying value
              // for `On` is the literal string 'on'.
              //
              // RUNTIME-VERIFIED (not just type-checked) via
              // app/tests/lightbulb-enum.runtime.test.ts — that test imports
              // the real monaco-editor bundle in a jsdom environment and
              // asserts `monaco.editor.ShowLightbulbIconMode.On === 'on'`
              // at runtime. If monaco-editor ever changes the enum value
              // (e.g. numeric in a future major version), the test will
              // catch it before this cast silently breaks.
              //
              // We can't import the enum as a value here without bloating
              // the bundle (we use `import type * as MonacoType` for types
              // only), so we cast the string literal through `unknown` to
              // the enum type. Safe because the literal 'on' matches the
              // enum's serialized value exactly (verified at runtime).
              lightbulb: {
                enabled: 'on' as unknown as MonacoType.editor.ShowLightbulbIconMode,
              },
              bracketPairColorization: { enabled: true },
              guides: {
                bracketPairs: true,
                indentation: true,
              },
              renderValidationDecorations: 'on',
              scrollbar: {
                verticalScrollbarSize: 6,
                horizontalScrollbarSize: 6,
              },
              overviewRulerLanes: 3,
              glyphMargin: true,  // needed for breakpoints/diagnostics in gutter
            }}
            loading={
              <div className="flex items-center justify-center h-full" style={{ color: 'var(--steel-silver)' }}>
                Loading editor...
              </div>
            }
          />
        ) : (
          /* Bug D fix — VS Code-style welcome screen. */
          <div
            className="flex flex-col items-center justify-center h-full gap-6 px-6"
            style={{ backgroundColor: '#07070B' }}
          >
            {/* Logo block */}
            <div className="flex flex-col items-center gap-3">
              <div
                className="w-20 h-20 rounded-2xl flex items-center justify-center"
                style={{
                  backgroundColor: 'var(--surface-dark)',
                  border: '1px solid var(--border-subtle)',
                  boxShadow: '0 0 24px rgba(238, 28, 28, 0.15)',
                }}
              >
                <span className="text-3xl font-display" style={{ color: 'var(--siren-red)' }}>ZT</span>
              </div>
              <div className="text-center">
                <p className="text-[15px] font-semibold" style={{ color: 'var(--bright-silver)' }}>
                  Zero Two: Code Siren
                </p>
                <p className="text-[12px] mt-1" style={{ color: 'var(--steel-silver)' }}>
                  {state.editorTabs.length === 0
                    ? 'Select a file from the Explorer to start editing'
                    : activeTab
                      ? `${activeTab.fileName} is empty`
                      : 'No file selected'}
                </p>
              </div>
            </div>

            {/* Action hints — VS Code-style quick actions */}
            <div className="flex flex-col gap-2 w-full max-w-[360px]">
              <div
                className="flex items-center gap-3 px-3 py-2 rounded-md"
                style={{
                  backgroundColor: 'var(--surface-dark)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <FilePlus2 className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--siren-red)' }} />
                <span className="text-[12px] flex-1" style={{ color: 'var(--bright-silver)' }}>
                  New File
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-code"
                  style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--muted-silver)' }}
                >
                  Ctrl+N
                </span>
              </div>

              <div
                className="flex items-center gap-3 px-3 py-2 rounded-md"
                style={{
                  backgroundColor: 'var(--surface-dark)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <Files className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--steel-silver)' }} />
                <span className="text-[12px] flex-1" style={{ color: 'var(--bright-silver)' }}>
                  Quick Open
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-code"
                  style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--muted-silver)' }}
                >
                  Ctrl+P
                </span>
              </div>

              <div
                className="flex items-center gap-3 px-3 py-2 rounded-md"
                style={{
                  backgroundColor: 'var(--surface-dark)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <Keyboard className="w-4 h-4 flex-shrink-0" style={{ color: 'var(--steel-silver)' }} />
                <span className="text-[12px] flex-1" style={{ color: 'var(--bright-silver)' }}>
                  Format Document
                </span>
                <span
                  className="text-[10px] px-1.5 py-0.5 rounded font-code"
                  style={{ backgroundColor: 'var(--surface-raised)', color: 'var(--muted-silver)' }}
                >
                  Ctrl+Shift+F
                </span>
              </div>
            </div>

            {/* Tip */}
            <p className="text-[10px] mt-2" style={{ color: 'var(--muted-silver)' }}>
              Open the Explorer on the left to browse project files
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
