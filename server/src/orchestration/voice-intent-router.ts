// server/src/orchestration/voice-intent-router.ts
// Phase B: Hands-Free — Voice-to-Code-Written v1.
//
// Classifies voice transcripts into { type: 'chat' | 'write-route', params? }
// using a structured LLM call with a strict JSON schema. Biases toward
// 'chat' on low confidence — ambiguous input never triggers a write path.
//
// v1 scope: only generateRoute-shaped requests are recognized as 'write-route'.
// Everything else (migrations, design tokens, free-form code) falls through
// to 'chat'.
//
// No free-form code generation. No editing of existing files. The only
// structured capability exposed to voice is BackendAgent.generateRoute().

import { modelRouter } from './model-router.js';

export type VoiceIntentType = 'chat' | 'write-route';

export interface WriteRouteParams {
  routeName: string;       // e.g. "login" → src/routes/login.ts
  description: string;     // e.g. "POST /api/login — authenticate user and return JWT"
  method?: string;         // GET | POST | PUT | DELETE (optional, included in description if absent)
  path?: string;           // e.g. "/api/login" (optional, defaults to /api/<routeName>)
  isPublic?: boolean;      // true = skip requireAuth (e.g. login/register). Default: false.
}

export interface VoiceIntent {
  type: VoiceIntentType;
  params?: WriteRouteParams;
  confidence: number;      // 0..1 — below CONFIDENCE_THRESHOLD, defaults to 'chat'
  rawResponse: string;  // for debugging / trace
}

export const CONFIDENCE_THRESHOLD = 0.7;  // below this, always 'chat'

// The trigger phrase that must be present before the router is invoked.
// Distinct, deliberate, unlikely to occur in normal speech. Does NOT
// overlap with "Hey Siren" (the deferred wake word).
//
// The trigger phrase is checked case-insensitively and allows minor ASR
// variation: "go siren", "go, siren", "go siren go" all match.
const TRIGGER_PHRASE_PATTERNS: RegExp[] = [
  /^go\s*,?\s*siren\b/i,
  /^that'?s?\s+it\s*,?\s*siren\b/i,
  /\bgo\s*,?\s*siren\b/i,  // anywhere in the transcript (for multi-turn accumulation)
];

/**
 * Check if a transcript contains the trigger phrase.
 * The trigger phrase is required before the intent router is invoked —
 * nothing gets acted on until it's heard.
 */
export function containsTriggerPhrase(transcript: string): boolean {
  const trimmed = transcript.trim().toLowerCase();
  return TRIGGER_PHRASE_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Strip the trigger phrase from the transcript, returning the remainder
 * that describes the actual request. e.g. "go siren add a login route" →
 * "add a login route".
 */
export function stripTriggerPhrase(transcript: string): string {
  let result = transcript;
  for (const p of TRIGGER_PHRASE_PATTERNS) {
    result = result.replace(p, '').trim();
  }
  return result;
}

const SYSTEM_PROMPT = `You are a voice intent classifier for Code Siren, an AI-powered IDE.
Your job: classify the user's spoken request as either "chat" or "write-route".

"write-route" means: the user is asking to CREATE a NEW backend API route (Express.js).
  Examples that should be classified as "write-route":
    - "add a login route"
    - "create a POST /api/register endpoint"
    - "scaffold a users route with GET and POST"
    - "add a logout route"
    - "create an endpoint for password reset"

"chat" means: anything else — questions, discussions, ambiguous requests, or requests
that don't clearly map to creating a new route file.
  Examples that should be "chat":
    - "how do I add a login route?" (asking HOW, not asking to DO it)
    - "explain how JWT auth works"
    - "what's the difference between POST and PUT?"
    - "create a database migration" (not a route — different capability)
    - "write me a function that hashes passwords" (free-form code, not a route)
    - "add a login route and also fix the bug in auth.ts" (editing existing — not v1)

Respond with ONLY a JSON object, no markdown fences, no explanation:
{"type": "chat", "confidence": 0.0}
or
{"type": "write-route", "confidence": 0.95, "params": {"routeName": "login", "description": "POST /api/login — authenticate user and return JWT", "method": "POST", "path": "/api/login", "isPublic": true}}

Rules:
1. If the request is ambiguous or you're not sure, return "chat" with low confidence.
2. routeName must be a valid filename (lowercase, hyphens, no spaces): "login", "user-profile", "password-reset".
3. description should capture the HTTP method + path + purpose in one line.
4. isPublic: true ONLY for routes that DON'T need auth (login, register, password-reset). Default: false.
5. confidence: how sure you are this is a write-route request. 0.0 = not at all, 1.0 = absolutely certain.
6. If the user mentions multiple routes or multiple actions, return "chat" (v1 handles one route at a time).
7. If the user mentions editing/modifying an existing file, return "chat" (v1 only creates new routes).`;

/**
 * Classify a voice transcript into a VoiceIntent.
 *
 * The transcript should already have the trigger phrase stripped.
 * If the LLM call fails or returns unparseable JSON, defaults to 'chat'
 * with confidence 0 — fail safe, never accidentally trigger a write.
 */
export async function classifyIntent(transcript: string): Promise<VoiceIntent> {
  const cleanedTranscript = transcript.trim();
  if (!cleanedTranscript) {
    return { type: 'chat', confidence: 0, rawResponse: '' };
  }

  let rawResponse = '';
  try {
    const stream = modelRouter.stream({
      agentId: 'voice-intent-router',
      domain: 'BACKEND' as any,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: cleanedTranscript },
      ],
      temperature: 0.1,  // low temperature for deterministic classification
      maxTokens: 256,    // JSON response is small
      executionMode: 'single-shot',
    });

    for await (const chunk of stream) {
      if (chunk.done) break;
      rawResponse += chunk.delta;
    }
  } catch (err: any) {
    console.warn(`[voice-intent-router] LLM call failed: ${err.message} — defaulting to chat`);
    return { type: 'chat', confidence: 0, rawResponse: `ERROR: ${err.message}` };
  }

  // Parse the JSON response — fail safe to 'chat' on any parse error
  try {
    // Strip markdown fences if present (some LLMs wrap JSON in ```json)
    let jsonStr = rawResponse.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr) as {
      type?: string;
      confidence?: number;
      params?: any;
    };

    // Validate type
    if (parsed.type !== 'chat' && parsed.type !== 'write-route') {
      console.warn(`[voice-intent-router] invalid type "${parsed.type}" — defaulting to chat`);
      return { type: 'chat', confidence: 0, rawResponse };
    }

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

    // Below threshold → always 'chat', regardless of what the LLM said
    if (confidence < CONFIDENCE_THRESHOLD) {
      return { type: 'chat', confidence, rawResponse };
    }

    // Validate write-route params
    if (parsed.type === 'write-route') {
      const params = parsed.params;
      if (!params || typeof params.routeName !== 'string' || typeof params.description !== 'string') {
        console.warn('[voice-intent-router] write-route missing required params — defaulting to chat');
        return { type: 'chat', confidence: 0, rawResponse };
      }
      // Sanitize routeName: only allow lowercase letters, numbers, hyphens
      const sanitizedRouteName = params.routeName.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!sanitizedRouteName) {
        console.warn('[voice-intent-router] routeName sanitized to empty — defaulting to chat');
        return { type: 'chat', confidence: 0, rawResponse };
      }
      return {
        type: 'write-route',
        confidence,
        params: {
          routeName: sanitizedRouteName,
          description: String(params.description).slice(0, 500),
          method: params.method ? String(params.method).toUpperCase().slice(0, 10) : undefined,
          path: params.path ? String(params.path).slice(0, 200) : undefined,
          isPublic: Boolean(params.isPublic),
        },
        rawResponse,
      };
    }

    return { type: 'chat', confidence, rawResponse };
  } catch (err: any) {
    console.warn(`[voice-intent-router] JSON parse failed: ${err.message} — defaulting to chat`);
    return { type: 'chat', confidence: 0, rawResponse };
  }
}
