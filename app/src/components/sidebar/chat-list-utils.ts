// app/src/components/sidebar/chat-list-utils.ts
//
// Pure functions for the Sidebar's chat-list computations. Extracted from
// Sidebar.tsx so the filter/sort logic is testable in isolation — without
// needing to mount the full Sidebar component (which pulls in motion/react,
// CardStack, icons, etc.).
//
// These functions MUST stay behaviorally identical to the inline logic they
// replaced in Sidebar.tsx. If you change the filter or sort behavior here,
// update Sidebar.tsx to call the new logic — do NOT duplicate.
//
// Contract (mirrors Sidebar.tsx's original useMemo/const blocks):
//   - filterChatSessions(sessions, '') returns sessions unchanged (no filter)
//   - filterChatSessions(sessions, 'foo') returns sessions whose name contains
//     'foo' (case-insensitive substring match)
//   - getRecentChats(sessions) returns the first 5 sessions in array order
//     (no sort — pure slice; the array order is the source of truth)

import type { ChatSession } from '@/types';

/**
 * Filter chat sessions by name (case-insensitive substring match).
 *
 * Empty/whitespace search query returns ALL sessions unchanged — matches the
 * original Sidebar.tsx behavior where an empty search box shows every chat.
 */
export function filterChatSessions(
  sessions: ChatSession[],
  searchQuery: string,
): ChatSession[] {
  if (!searchQuery.trim()) return sessions;
  const q = searchQuery.toLowerCase();
  return sessions.filter(c => c.name.toLowerCase().includes(q));
}

/**
 * Get the recent chats — first 5 sessions in array order.
 *
 * Pure slice, no sort by timestamp or any other field. The array order is
 * the source of truth: new sessions appended via CREATE_CHAT_SESSION appear
 * at the end, so a new session shows up at the end of recentChats (position
 * 4 if there are 4 total sessions, etc.).
 */
export function getRecentChats(sessions: ChatSession[]): ChatSession[] {
  return sessions.slice(0, 5);
}
