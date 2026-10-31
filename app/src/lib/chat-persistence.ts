// app/src/lib/chat-persistence.ts
// Auto-save + auto-name chat sessions.
//
// Persistence: chat sessions are saved to localStorage on every change
// (debounced 1s). On boot, they're loaded back into AppContext.
//
// Auto-naming: when a chat has its first user message but is still named
// "New Chat", we generate a title from the first 3-5 words of the message.
// This is instant (no LLM call needed) and gives a meaningful name like
// "Fix auth middleware bug" instead of "New Chat".

const STORAGE_KEY = 'code_siren_chats';
const ACTIVE_CHAT_KEY = 'code_siren_active_chat';
const SAVE_DEBOUNCE_MS = 1000;

interface PersistedChat {
  id: string;
  name: string;
  messages: ChatMessageLite[];
  lastActivity: number;
}

interface ChatMessageLite {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  agentName?: string;
}

/** Minimal shape of a chat session for persistence (avoids circular deps). */
interface PersistableSession {
  id: string;
  name: string;
  messages: ChatMessageLite[];
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Debounced save of chat sessions to localStorage.
 * Called on every chatSessions state change.
 */
export function saveChats(sessions: PersistableSession[]): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const persisted: PersistedChat[] = sessions.map((s) => ({
        id: s.id,
        name: s.name,
        messages: s.messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
          agentName: m.agentName,
        })),
        lastActivity: Date.now(),
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
    } catch (err) {
      // localStorage might be full or unavailable — fail silently
      console.warn('[chat-persistence] save failed:', err);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Load saved chat sessions from localStorage on boot.
 * Returns null if nothing saved or storage unavailable.
 */
export function loadChats(): PersistedChat[] | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedChat[];
    if (!Array.isArray(parsed)) return null;
    // Sort by lastActivity (most recent first)
    return parsed.sort((a, b) => b.lastActivity - a.lastActivity);
  } catch {
    return null;
  }
}

/**
 * Save the active chat ID so the user returns to the same chat on reload.
 */
export function saveActiveChatId(chatId: string): void {
  try {
    localStorage.setItem(ACTIVE_CHAT_KEY, chatId);
  } catch {
    // ignore
  }
}

/**
 * Load the last active chat ID.
 */
export function loadActiveChatId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_CHAT_KEY);
  } catch {
    return null;
  }
}

/**
 * Generate a chat title from the first user message.
 * Takes the first 3-5 words, capitalizes, trims to 40 chars.
 *
 * Examples:
 *   "how do I fix the auth bug" → "How do I fix the..."
 *   "build a react component" → "Build a React component"
 *   "explain this code" → "Explain this code"
 */
export function generateChatTitle(firstUserMessage: string): string {
  const trimmed = firstUserMessage.trim();
  if (!trimmed) return 'New Chat';

  // Take first 5 words
  const words = trimmed.split(/\s+/).slice(0, 5);
  let title = words.join(' ');

  // Capitalize first letter
  title = title.charAt(0).toUpperCase() + title.slice(1);

  // Truncate to 40 chars with ellipsis
  if (title.length > 40) {
    title = title.slice(0, 37) + '...';
  }

  return title;
}

/**
 * Check if a chat needs auto-naming (still named "New Chat" and has messages).
 */
export function needsAutoName(session: { name: string; messages: { role: string; content: string }[] }): boolean {
  return session.name === 'New Chat' &&
         session.messages.some((m) => m.role === 'user' && m.content.trim().length > 0);
}

/**
 * Clear all saved chats (for logout / reset).
 */
export function clearSavedChats(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(ACTIVE_CHAT_KEY);
  } catch {
    // ignore
  }
}
