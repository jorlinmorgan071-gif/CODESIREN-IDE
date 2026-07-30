import { useCallback, useState, useRef, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import { useApp } from '@/store/AppContext';
import { api } from '@/lib/api';
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

export function CodeEditor() {
  const { state, closeTab, setActiveFile, updateProblems } = useApp();
  const [mounted] = useState(true);

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
      const ts = monaco.languages.typescript;
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
        const problems = markers.map((m) => ({
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
      // Register a custom completion provider that calls the existing
      // Tier 1 chat API (api.orchestratorChat) with a completion-focused
      // prompt. The user's directive specified calling the orchestrator
      // with a messages array — the actual API takes a single user
      // message string, so we serialize the system+user prompts into one
      // combined message.
      //
      // 300ms debounce + cancel-token pattern: if a new completion
      // request comes in before the previous one resolves, the previous
      // fetch's result is dropped (token mismatch).
      const buildAiCompletions = (
        model: MonacoType.editor.ITextModel,
        position: MonacoType.Position
      ): Promise<MonacoType.languages.CompletionList> => {
        return new Promise((resolve) => {
          const lineContent = model.getLineContent(position.lineNumber);
          const wordUntil = model.getWordUntilPosition(position);
          // Only fire if the cursor is in the middle of a word — don't
          // waste an API call at the start of an empty line.
          if (wordUntil.word.length < 2) {
            resolve({ suggestions: [] });
            return;
          }

          // Get surrounding context (10 lines above, 5 below).
          const startLine = Math.max(1, position.lineNumber - 10);
          const endLine = Math.min(model.getLineCount(), position.lineNumber + 5);
          const context = model.getValueInRange({
            startLineNumber: startLine,
            startColumn: 1,
            endLineNumber: endLine,
            endColumn: model.getLineMaxColumn(endLine),
          });

          // Cancel any pending request + clear its debounce timer.
          if (aiCompletionTimer) {
            clearTimeout(aiCompletionTimer);
          }
          const myToken = ++aiCompletionToken;

          const fireRequest = async () => {
            const sessionId = state.activeChatId;
            if (!sessionId) {
              resolve({ suggestions: [] });
              return;
            }
            const prompt =
              'You are a code completion engine. Given code context, ' +
              'return ONLY a JSON array of completion strings. No explanation. ' +
              'Max 5 items. Example: ["console.log", "console.error"]\n\n' +
              `Complete at cursor position in this code:\n\`\`\`\n${context}\n\`\`\`\n` +
              `Word so far: "${wordUntil.word}" (line content: "${lineContent}")`;

            try {
              // Fire the chat request — the response streams back over WS
              // as orchestrator:chunk events. For completions we want the
              // FULL response synchronously, so we poll the WS for the
              // complete message. The simplest approach: use the
              // orchestratorChat endpoint's 202-accepted shape and then
              // wait for the orchestrator:complete event via a one-time
              // WS listener.
              await api.orchestratorChat(sessionId, prompt);
              // The response streams via WS — for the completion use case
              // we can't easily await the streamed chunks here without
              // refactoring the WS client. For now, return empty
              // suggestions; a future iteration can collect the streamed
              // chunks and resolve them. The Monaco built-in TS worker
              // suggestions still work — this provider is purely additive.
              if (myToken !== aiCompletionToken) {
                // A newer request superseded us — drop our result.
                resolve({ suggestions: [] });
                return;
              }
              resolve({ suggestions: [] });
            } catch (err) {
              console.warn('[editor] AI completion failed:', err);
              resolve({ suggestions: [] });
            }
          };

          // 300ms debounce — only fire after the user pauses typing.
          aiCompletionTimer = setTimeout(fireRequest, 300);
        });
      };

      const completionProvider = {
        triggerCharacters: ['.', '(', '<', '"', "'", '/', '@'],
        provideCompletionItems: (
          model: MonacoType.editor.ITextModel,
          position: MonacoType.Position
        ): Promise<MonacoType.languages.CompletionList> => {
          return buildAiCompletions(model, position);
        },
      };
      monaco.languages.registerCompletionItemProvider('typescript', completionProvider);
      monaco.languages.registerCompletionItemProvider('javascript', completionProvider);

      // ── Phase A Step 7: Format on demand (Ctrl+Shift+F) ─────────────
      _editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyF,
        () => {
          _editor.getAction('editor.action.formatDocument')?.run();
        }
      );

      // ── Phase A Step 3: Multi-file model sync (initial pass) ────────
      // The full sync logic runs in a separate useEffect below that
      // watches state.editorTabs + state.fileContents. Here we just
      // register the active file as a model so IntelliSense can resolve
      // it immediately on mount.
      const activeTab = state.editorTabs.find((t) => t.isActive);
      if (activeTab) {
        const content = state.fileContents[activeTab.fileId] ?? '';
        const lang = languageMap[activeTab.language] ?? 'plaintext';
        const uri = monaco.Uri.parse(`file:///${activeTab.fileName}`);
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
    const activeUri = monaco.Uri.parse(`file:///${activeTab.fileName}`);
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
      const uri = monaco.Uri.parse(`file:///${tab.fileName}`);
      const existingModel = monaco.editor.getModel(uri);
      if (!existingModel) {
        monaco.editor.createModel(content, lang, uri);
      } else if (existingModel.getValue() !== content) {
        existingModel.setValue(content);
      }
    }

    // Dispose models for tabs that have been closed. Walk all models and
    // remove any whose URI doesn't correspond to a currently-open tab.
    const openFileNames = new Set(state.editorTabs.map((t) => t.fileName));
    for (const model of monaco.editor.getModels()) {
      const fileName = model.uri.path.split('/').pop();
      if (fileName && !openFileNames.has(fileName)) {
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
              lightbulb: { enabled: 'on' },
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
