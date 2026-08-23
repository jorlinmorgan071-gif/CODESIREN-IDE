import { describe, expect, it } from 'vitest';
import { appReducer, initialState } from '../src/store/AppContext';

describe('authoritative change transaction editor reconciliation', () => {
  it('retains only the server-derived workspace path when loading a real workspace file inventory', () => {
    const loaded = appReducer(initialState, {
      type: 'LOAD_WORKSPACE_FILES',
      payload: [{ path: 'src/main.ts', name: 'main.ts' }],
    });
    expect(loaded.fileTree[0]).toMatchObject({ id: 'workspace:src/main.ts', name: 'main.ts', workspacePath: 'src/main.ts' });
    expect(loaded.editorTabs).toEqual([]);
    expect(loaded.activeFileId).toBeNull();
  });

  it('updates the existing file buffer and clears only the reconciled tab modification marker', () => {
    const before = {
      ...initialState,
      fileContents: { ...initialState.fileContents, f17: 'const before = true;' },
      editorTabs: initialState.editorTabs.map((tab) =>
        tab.fileId === 'f17' ? { ...tab, isModified: true } : tab
      ),
    };
    const after = appReducer(before, {
      type: 'RECONCILE_FILE_CONTENT',
      payload: { fileId: 'f17', content: 'const after = true;' },
    });

    expect(after.fileContents.f17).toBe('const after = true;');
    expect(after.editorTabs.find((tab) => tab.fileId === 'f17')?.isModified).toBe(false);
    expect(after.editorTabs.filter((tab) => tab.fileId !== 'f17')).toEqual(before.editorTabs.filter((tab) => tab.fileId !== 'f17'));
  });

  it('accepts server-read content only for the tab carrying the matching canonical workspace path', () => {
    const before = {
      ...initialState,
      editorTabs: [{ fileId: 'workspace:src/main.ts', fileName: 'main.ts', workspacePath: 'src/main.ts', language: 'typescript', isModified: false, isActive: true }],
      activeFileId: 'workspace:src/main.ts',
      fileContents: {},
    };
    const after = appReducer(before, {
      type: 'SET_WORKSPACE_FILE_CONTENT',
      payload: { fileId: 'workspace:src/main.ts', path: 'src/main.ts', content: 'export const source = true;\n' },
    });
    expect(after.fileContents['workspace:src/main.ts']).toBe('export const source = true;\n');
    expect(appReducer(before, {
      type: 'SET_WORKSPACE_FILE_CONTENT',
      payload: { fileId: 'workspace:src/main.ts', path: 'other/main.ts', content: 'wrong target' },
    })).toBe(before);
  });
});
