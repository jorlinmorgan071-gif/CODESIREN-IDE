import { useState } from 'react';
import { useApp } from '@/store/AppContext';
import type { FileNode } from '@/types';
import {
  ChevronRight,
  ChevronDown,
  Folder,
  FolderOpen,
  FileCode,
  FileJson,
  FileType,
  FileText,
  File,
  MoreHorizontal,
  RefreshCw,
  Plus,
} from 'lucide-react';

function getFileIcon(node: FileNode) {
  if (node.type === 'folder') {
    return node.isOpen ? FolderOpen : Folder;
  }
  switch (node.language) {
    case 'typescript':
    case 'javascript':
      return FileCode;
    case 'json':
      return FileJson;
    case 'css':
      return FileType;
    case 'markdown':
      return FileText;
    default:
      return File;
  }
}

function getFileColor(node: FileNode) {
  if (node.type === 'folder') {
    return node.isOpen ? 'var(--siren-red)' : 'var(--steel-silver)';
  }
  switch (node.language) {
    case 'typescript':
      return '#3B82F6';
    case 'javascript':
      return '#F59E0B';
    case 'css':
      return '#06B6D4';
    case 'json':
      return '#22C55E';
    case 'markdown':
      return 'var(--bright-silver)';
    case 'html':
      return '#F97316';
    default:
      return 'var(--steel-silver)';
  }
}

interface FileTreeItemProps {
  node: FileNode;
  depth: number;
}

function FileTreeItem({ node, depth }: FileTreeItemProps) {
  const { state, toggleFolder, openFile } = useApp();
  const Icon = getFileIcon(node);
  const color = getFileColor(node);
  const isActive = state.activeFileId === node.id;

  const handleClick = () => {
    if (node.type === 'folder') {
      toggleFolder(node.id);
    } else {
      openFile(node.id);
    }
  };

  return (
    <div>
      <button
        className="w-full flex items-center gap-1 px-2 py-[3px] text-[13px] transition-colors relative group"
        style={{
          paddingLeft: `${8 + depth * 12}px`,
          backgroundColor: isActive ? 'rgba(238, 28, 28, 0.08)' : 'transparent',
          color: isActive ? 'var(--bright-silver)' : 'var(--steel-silver)',
        }}
        onClick={handleClick}
      >
        {isActive && (
          <div
            className="absolute left-0 top-0 bottom-0 w-0.5"
            style={{ backgroundColor: 'var(--siren-red)' }}
          />
        )}

        {node.type === 'folder' && (
          <span className="flex-shrink-0" style={{ color: 'var(--muted-silver)' }}>
            {node.isOpen ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )}
          </span>
        )}

        {/* eslint-disable-next-line react-hooks/static-components */}
        <Icon className="w-4 h-4 flex-shrink-0" style={{ color }} />

        <span className="truncate flex-1 text-left">{node.name}</span>

        {node.isModified && (
          <div className="w-1.5 h-1.5 rounded-full flex-shrink-0 animate-agent-pulse" style={{ backgroundColor: 'var(--siren-red)' }} />
        )}

        <button
          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded"
          style={{ color: 'var(--muted-silver)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <MoreHorizontal className="w-3 h-3" />
        </button>
      </button>

      {node.type === 'folder' && node.isOpen && node.children && (
        <div>
          {node.children.map((child) => (
            <FileTreeItem key={child.id} node={child} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

export function FileExplorer() {
  const { state } = useApp();
  const [filter, setFilter] = useState('');

  return (
    <div
      className="w-[190px] flex flex-col overflow-hidden"
      style={{
        backgroundColor: 'var(--surface-dark)',
        borderRight: '1px solid var(--border-subtle)',
      }}
    >
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
          Explorer
        </span>
        <div className="flex items-center gap-1">
          <button
            className="p-1 rounded transition-colors hover:bg-white/5"
            style={{ color: 'var(--muted-silver)' }}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
          <button
            className="p-1 rounded transition-colors hover:bg-white/5"
            style={{ color: 'var(--muted-silver)' }}
          >
            <RefreshCw className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Project name */}
      <div className="px-3 py-1.5">
        <span className="text-[13px] font-medium" style={{ color: 'var(--bright-silver)' }}>
          E-Commerce Platform
        </span>
      </div>

      {/* Filter */}
      <div className="px-2 pb-2">
        <input
          type="text"
          placeholder="Filter files..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="w-full px-2 py-1 text-[11px] rounded zt-input"
          style={{ color: 'var(--bright-silver)' }}
        />
      </div>

      {/* File tree */}
      <div className="flex-1 overflow-y-auto">
        {state.fileTree.map((node) => (
          <FileTreeItem key={node.id} node={node} depth={0} />
        ))}
      </div>

      {/* Works Analysis Module */}
      <div
        style={{
          borderTop: '1px solid var(--border-subtle)',
        }}
      >
        <div className="px-3 py-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: 'var(--steel-silver)' }}>
            Works Analysis
          </span>
        </div>
        <div className="px-3 pb-3 space-y-2">
          {/* Progress ring */}
          <div className="flex items-center gap-3">
            <div className="relative w-10 h-10 flex-shrink-0">
              <svg className="w-10 h-10 -rotate-90" viewBox="0 0 48 48">
                <circle
                  cx="24"
                  cy="24"
                  r="20"
                  fill="none"
                  stroke="var(--border-subtle)"
                  strokeWidth="3"
                />
                <circle
                  cx="24"
                  cy="24"
                  r="20"
                  fill="none"
                  stroke="var(--siren-red)"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={`${2 * Math.PI * 20}`}
                  strokeDashoffset={`${2 * Math.PI * 20 * (1 - 68 / 100)}`}
                  className="transition-all duration-700"
                />
              </svg>
              <span
                className="absolute inset-0 flex items-center justify-center text-[10px] font-bold"
                style={{ color: 'var(--bright-silver)' }}
              >
                68%
              </span>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[11px] truncate" style={{ color: 'var(--bright-silver)' }}>
                E-Commerce Platform
              </div>
              <div className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>
                5 agents working
              </div>
            </div>
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#22C55E' }} />
              <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>142 files</span>
            </div>
            <div className="flex items-center gap-1">
              <div className="w-1.5 h-1.5 rounded-full animate-agent-pulse" style={{ backgroundColor: 'var(--siren-red)' }} />
              <span className="text-[10px]" style={{ color: 'var(--muted-silver)' }}>3 errors</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
