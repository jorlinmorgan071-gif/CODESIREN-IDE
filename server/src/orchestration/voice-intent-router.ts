// server/src/orchestration/voice-intent-router.ts
// Phase B: Hands-Free — Voice-to-Code-Written v1.
//
// Classifies voice transcripts into { type, params?, confidence } using a
// structured LLM call with a strict JSON schema. Biases toward 'chat' on
// low confidence — ambiguous input never triggers a write path.
//
// v1 scope: three structured capabilities are exposed to voice:
//   - write-route      → BackendAgent.generateRoute()
//   - write-migration  → DatabaseAgent.designMigration()
//   - write-component  → UIDesigner.generateComponent()
//
// Everything else falls through to 'chat'. No free-form code generation.
// No editing of existing files.

import { modelRouter } from './model-router.js';

export type VoiceIntentType = 'chat' | 'write-route' | 'write-migration' | 'write-component';

// ── Params shapes for each write capability ─────────────────────────────

export interface WriteRouteParams {
  routeName: string;       // e.g. "login" → src/routes/login.ts
  description: string;     // e.g. "POST /api/login — authenticate user and return JWT"
  method?: string;         // GET | POST | PUT | DELETE (optional)
  path?: string;           // e.g. "/api/login" (optional, defaults to /api/<routeName>)
  isPublic?: boolean;      // true = skip requireAuth (e.g. login/register). Default: false.
}

export interface WriteMigrationParams {
  description: string;     // e.g. "add a users table with id, email, password_hash, created_at"
}

export interface WriteComponentParams {
  componentName: string;   // e.g. "UserCard" → UserCard.tsx
  description: string;     // e.g. "a card showing user avatar, name, and email"
  componentPath?: string;  // e.g. "app/src/components/ui/UserCard.tsx" (optional, auto-generated if absent)
  includeIcons?: boolean;  // include lucide-react import
  includeAnimation?: boolean; // include motion/react import
}

export type WriteParams = WriteRouteParams | WriteMigrationParams | WriteComponentParams;

export interface VoiceIntent {
  type: VoiceIntentType;
  params?: WriteParams;
  confidence: number;      // 0..1 — below CONFIDENCE_THRESHOLD, defaults to 'chat'
  rawResponse: string;     // for debugging / trace
}

export const CONFIDENCE_THRESHOLD = 0.7;  // below this, always 'chat'

// The trigger phrase that must be present before the router is invoked.
// Distinct, deliberate, unlikely to occur in normal speech. Does NOT
// overlap with "Hey Siren" (the deferred wake word).
const TRIGGER_PHRASE_PATTERNS: RegExp[] = [
  /^go\s*,?\s*siren\b/i,
  /^that'?s?\s+it\s*,?\s*siren\b/i,
  /\bgo\s*,?\s*siren\b/i,
];

/**
 * Check if a transcript contains the trigger phrase.
 */
export function containsTriggerPhrase(transcript: string): boolean {
  const trimmed = transcript.trim().toLowerCase();
  return TRIGGER_PHRASE_PATTERNS.some(p => p.test(trimmed));
}

/**
 * Strip the trigger phrase from the transcript, returning the remainder.
 */
export function stripTriggerPhrase(transcript: string): string {
  let result = transcript;
  for (const p of TRIGGER_PHRASE_PATTERNS) {
    result = result.replace(p, '').trim();
  }
  return result;
}

const SYSTEM_PROMPT = `You are a voice intent classifier for Code Siren, an AI-powered IDE.
Your job: classify the user's spoken request as one of: "chat", "write-route", "write-migration", or "write-component".

"write-route" means: the user is asking to CREATE a NEW backend API route (Express.js).
  Examples: "add a login route", "create a POST /api/register endpoint", "scaffold a users route"

"write-migration" means: the user is asking to CREATE a NEW database migration (SQL file).
  Examples: "create a migration for a users table", "add a migration for user profiles",
  "I need a migration to add a created_at column"

"write-component" means: the user is asking to CREATE a NEW React/UI component.
  Examples: "create a UserCard component", "add a button component with animation",
  "make a sidebar component with icons"

"chat" means: anything else — questions, discussions, ambiguous requests, or requests
that don't clearly map to creating a new file.
  Examples: "how do I add a login route?" (asking HOW, not DO it),
  "explain how JWT auth works", "what's the difference between POST and PUT?",
  "write me a function that hashes passwords" (free-form code, not a component)

Respond with ONLY a JSON object, no markdown fences, no explanation.

For "chat":
{"type": "chat", "confidence": 0.0}

For "write-route":
{"type": "write-route", "confidence": 0.95, "params": {"routeName": "login", "description": "POST /api/login — authenticate user and return JWT", "method": "POST", "path": "/api/login", "isPublic": true}}

For "write-migration":
{"type": "write-migration", "confidence": 0.92, "params": {"description": "create a users table with id, email, password_hash, created_at"}}

For "write-component":
{"type": "write-component", "confidence": 0.90, "params": {"componentName": "UserCard", "description": "a card showing user avatar, name, and email", "includeIcons": true, "includeAnimation": false}}

Rules:
1. If the request is ambiguous or you're not sure, return "chat" with low confidence.
2. routeName: valid filename (lowercase, hyphens, no spaces): "login", "user-profile".
3. componentName: PascalCase: "UserCard", "Sidebar", "LoginButton".
4. description: one-line summary of what the file should do.
5. isPublic: true ONLY for routes that DON'T need auth (login, register). Default: false.
6. confidence: 0.0 = not at all, 1.0 = absolutely certain. Below 0.7 → forced to chat.
7. If the user mentions multiple files or multiple actions, return "chat" (one at a time).
8. If the user mentions editing/modifying an existing file, return "chat" (v1 only creates new files).
9. For migrations: the description should capture what tables/columns to create.
10. For components: includeIcons/includeAnimation are booleans (default false).`;

/**
 * Classify a voice transcript into a VoiceIntent.
 * Fails safe to 'chat' on any error.
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
      temperature: 0.1,
      maxTokens: 256,
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

  try {
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

    const validTypes = ['chat', 'write-route', 'write-migration', 'write-component'];
    if (!validTypes.includes(parsed.type ?? '')) {
      console.warn(`[voice-intent-router] invalid type "${parsed.type}" — defaulting to chat`);
      return { type: 'chat', confidence: 0, rawResponse };
    }

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;

    if (confidence < CONFIDENCE_THRESHOLD) {
      return { type: 'chat', confidence, rawResponse };
    }

    // Validate params for each write type
    if (parsed.type === 'write-route') {
      const params = parsed.params;
      if (!params || typeof params.routeName !== 'string' || typeof params.description !== 'string') {
        return { type: 'chat', confidence: 0, rawResponse };
      }
      const sanitizedRouteName = sanitizeFilename(params.routeName);
      if (!sanitizedRouteName) {
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
        } as WriteRouteParams,
        rawResponse,
      };
    }

    if (parsed.type === 'write-migration') {
      const params = parsed.params;
      if (!params || typeof params.description !== 'string') {
        return { type: 'chat', confidence: 0, rawResponse };
      }
      return {
        type: 'write-migration',
        confidence,
        params: {
          description: String(params.description).slice(0, 500),
        } as WriteMigrationParams,
        rawResponse,
      };
    }

    if (parsed.type === 'write-component') {
      const params = parsed.params;
      if (!params || typeof params.componentName !== 'string' || typeof params.description !== 'string') {
        return { type: 'chat', confidence: 0, rawResponse };
      }
      // Sanitize componentName to PascalCase
      const sanitized = sanitizeComponentName(params.componentName);
      if (!sanitized) {
        return { type: 'chat', confidence: 0, rawResponse };
      }
      return {
        type: 'write-component',
        confidence,
        params: {
          componentName: sanitized,
          description: String(params.description).slice(0, 500),
          componentPath: params.componentPath ? String(params.componentPath).slice(0, 300) : undefined,
          includeIcons: Boolean(params.includeIcons),
          includeAnimation: Boolean(params.includeAnimation),
        } as WriteComponentParams,
        rawResponse,
      };
    }

    return { type: 'chat', confidence, rawResponse };
  } catch (err: any) {
    console.warn(`[voice-intent-router] JSON parse failed: ${err.message} — defaulting to chat`);
    return { type: 'chat', confidence: 0, rawResponse };
  }
}

/** Sanitize a filename: lowercase, hyphens, no spaces. */
function sanitizeFilename(name: string): string {
  return name.toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** Sanitize a component name: PascalCase, alphanumeric only. */
function sanitizeComponentName(name: string): string {
  // Remove non-alphanumeric, then PascalCase
  const cleaned = name.replace(/[^a-zA-Z0-9]/g, '');
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}
