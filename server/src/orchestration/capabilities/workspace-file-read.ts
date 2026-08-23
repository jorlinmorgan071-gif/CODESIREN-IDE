import { lstatSync, readFileSync } from 'node:fs';
import { toolRegistry, type Tool, type ToolResult } from '../../agents/_shared/tool-registry.js';
import { resolveWorkspacePath, workspaceRelativePath, type WorkspaceIdentity } from '../../workspace/service.js';

const MAX_READ_BYTES = 1_000_000;

/**
 * Creates a task-scoped, read-only capability for one server-resolved workspace.
 * It is intentionally not registered in the global tool registry: normal chat
 * must not gain access to unrelated global tools through a request classifier.
 */
export function createWorkspaceFileReadTool(workspace: WorkspaceIdentity): Tool {
  return {
    name: 'workspace_file_read',
    description: 'Read one existing text file below the authenticated workspace root. Args: { path: string }',
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const requestedPath = typeof args.path === 'string' ? args.path : '';
      try {
        const absolutePath = resolveWorkspacePath(workspace, requestedPath, { mustExist: true });
        const stat = lstatSync(absolutePath);
        if (!stat.isFile() || stat.size > MAX_READ_BYTES) {
          return {
            name: 'workspace_file_read',
            content: 'The requested workspace path is not an editable text file within the read-size limit.',
            success: false,
          };
        }
        const path = workspaceRelativePath(workspace, requestedPath);
        return {
          name: 'workspace_file_read',
          content: readFileSync(absolutePath, 'utf8'),
          success: true,
          meta: { path, bytes: stat.size },
        } as ToolResult;
      } catch (error) {
        return {
          name: 'workspace_file_read',
          content: error instanceof Error ? error.message : 'Workspace file read failed',
          success: false,
        };
      }
    },
  };
}

/** Execute a task-scoped tool through the registry's common exception handling. */
export async function executeWorkspaceFileRead(
  workspace: WorkspaceIdentity,
  path: string,
): Promise<ToolResult> {
  return toolRegistry.executeScoped(createWorkspaceFileReadTool(workspace), { path });
}
