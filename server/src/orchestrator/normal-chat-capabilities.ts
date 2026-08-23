export type NormalChatCapability =
  | { kind: 'general-chat' }
  | { kind: 'read-explain'; path: string }
  | { kind: 'change-plan' };

const CHANGE_INTENT = /\b(fix|repair|patch|modify|change|update|implement|refactor|write|edit|make)\b/i;
const EXPLICIT_FILE_READ_INTENT = /^(?=[\s\S]*\b(?:read|open|inspect)\b)(?=[\s\S]*\b(?:explain|describe|summari[sz]e|analy[sz]e)\b)(?=[\s\S]*\bfile\b)[\s\S]*$/i;

/**
 * Select only capabilities that are safe to infer from a normal chat message.
 * Write-like wording always resolves to a review-only plan, never execution.
 * Read-like wording requires a canonical active workspace path supplied by the
 * server after WorkspaceService sanitization.
 */
export function selectNormalChatCapability(message: string, activeWorkspacePath?: string): NormalChatCapability {
  if (CHANGE_INTENT.test(message)) return { kind: 'change-plan' };
  if (activeWorkspacePath && EXPLICIT_FILE_READ_INTENT.test(message)) {
    return { kind: 'read-explain', path: activeWorkspacePath };
  }
  return { kind: 'general-chat' };
}
