// server/src/orchestration/content-blocks.ts
// Phase 3+ — Content block helpers for vision/multimodal routing.
//
// RouterMessage.content was widened from `string` to `string | ContentBlock[]`
// to support image blocks. These helpers let engines extract text + convert
// between OpenAI-style content blocks (used by OpenRouter) and Anthropic's
// format (which uses `source` instead of `image_url`).

import type { ContentBlock, RouterMessage } from '../types.js';

/**
 * Extract the text portion of a RouterMessage's content.
 * - If content is a string, returns it directly.
 * - If content is an array of blocks, concatenates all text blocks.
 *
 * Used by engines that need the text for logging, system-prompt extraction,
 * or follow-up detection (where image content is irrelevant).
 */
export function extractText(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

/**
 * Convert RouterMessage content to OpenAI/OpenRouter format.
 * OpenRouter accepts the content-block array natively (OpenAI-compatible),
 * so this is a pass-through — string stays string, array stays array.
 */
export function toOpenRouterContent(content: string | ContentBlock[]): string | ContentBlock[] {
  return content;
}

/**
 * Convert RouterMessage content to Anthropic's format.
 * Anthropic uses a different shape for images:
 *   OpenAI:     { type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }
 *   Anthropic: { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }
 *
 * Text blocks pass through unchanged.
 */
export function toAnthropicContent(content: string | ContentBlock[]): string | Array<
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
> {
  if (typeof content === 'string') return content;

  return content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text' as const, text: block.text };
    }
    // image_url → Anthropic image source
    const url = block.image_url.url;
    // Parse the data URI: "data:image/png;base64,iVBOR..."
    const match = url.match(/^data:(image\/[a-z]+);base64,(.+)$/);
    if (match) {
      const [, mediaType, data] = match;
      return {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: mediaType, data },
      };
    }
    // If it's a URL (not a data URI), Anthropic supports URL sources too,
    // but only with their Messages API v2. For now, skip non-data-URI images.
    // (The vision route always sends data URIs, so this path shouldn't hit.)
    console.warn('[content-blocks] non-data-URI image not supported for Anthropic, skipping');
    return { type: 'text' as const, text: '(image not supported)' };
  });
}

/**
 * Check whether a RouterMessage contains any image blocks.
 */
export function hasImageContent(content: string | ContentBlock[]): boolean {
  if (typeof content === 'string') return false;
  return content.some((block) => block.type === 'image_url');
}
