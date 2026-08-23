export function createChatSessionId(): string {
  if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
    throw new Error('Secure browser UUID generation is unavailable; a durable chat session cannot be created.');
  }
  return crypto.randomUUID();
}
