// server/src/routes/voice.ts
// Voice API — directive Section 6 + Section 7.
//   POST /api/voice/start         start a voice session
//   POST /api/voice/stop          stop a voice session
//   POST /api/voice/transcript    submit a voice transcript → AgentManager.send()
//   GET  /api/voice/settings      get voice provider settings + available providers + voices
//   POST /api/voice/settings      update voice provider settings (runtime swap + persist)
//
// Per directive Section 7: "A spoken command and a typed command must resolve
// to the SAME AgentTask shape and travel through the SAME AgentManager.send()
// call. Voice is a transport, not a second brain."
//
// The transcript route creates an AgentTask with origin: 'voice' — the ONLY
// difference from a typed chat task (origin: 'chat'). Everything else
// (agentId, type, executionMode, context, priority) is identical. The task
// goes through the same AgentManager.send() → same agent:chunk WS events →
// same trace recorder.
//
// Phase E Build 2: added /settings routes mirroring /api/orchestrator/settings.
// POST /settings both persists AND applies the change at runtime via
// applyVoiceProvider(next), so the swap takes effect immediately without
// requiring a server restart.

import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { getVoiceClient } from '../systems/voice/voice-client.js';
import { agentManager } from '../orchestration/agent-manager.js';
import type { AgentTask } from '../types.js';
import { ProjectAccessError, resolveTenantScope } from '../tenancy/scope.js';
import {
  getVoiceSettings,
  setVoiceSettings,
  applyVoiceProvider,
  getVoiceProviders,
  VOICE_PROVIDERS,
  KOKORO_VOICES,
  ELEVENLABS_VOICES,
} from '../orchestrator/voice-settings.js';

export const voiceRouter = Router();

const startSchema = z.object({
  projectId: z.string().uuid().optional(),
});

voiceRouter.post('/start', requireAuth, async (req, res) => {
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const client = getVoiceClient();
  const session = await client.startSession();
  res.json({ session, implementation: client.implementation });
});

voiceRouter.post('/stop', requireAuth, async (req, res) => {
  const schema = z.object({ sessionId: z.string() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }
  const client = getVoiceClient();
  await client.stopSession(parsed.data.sessionId);
  res.json({ stopped: true });
});

// ── The critical route: voice transcript → AgentManager.send() ───────────
// This is the ONE place where voice enters the system. It creates an AgentTask
// with origin: 'voice' and sends it through the SAME AgentManager.send() as
// typed chat. The task shape is identical to a typed chat task except for the
// 'origin' field.

const transcriptSchema = z.object({
  text: z.string().min(1).max(8000),
  agentId: z.string().default('architect-agent'),
  type: z.string().default('chat'),
  executionMode: z.enum(['single-shot', 'react', 'codeact']).default('single-shot'),
  projectId: z.string().uuid().optional(),
  sessionId: z.string().uuid().optional(),
});

voiceRouter.post('/transcript', requireAuth, async (req, res) => {
  const parsed = transcriptSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  // Verify the agent exists
  const agent = agentManager.get(parsed.data.agentId);
  if (!agent) {
    res.status(404).json({ error: `Unknown agent: ${parsed.data.agentId}` });
    return;
  }

  // Step 1: Transcribe (stub returns the text directly; real impl would
  // process audio, but the caller can also pass pre-recognized text)
  const client = getVoiceClient();
  const transcript = await client.transcribe(parsed.data.text);

  // Step 2: Resolve ownership server-side before creating the task. A voice
  // client cannot choose another project's event, trace, or memory scope.
  let scope;
  try {
    scope = await resolveTenantScope(req.user!.id, parsed.data.projectId);
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      res.status(403).json({ error: 'Project access denied' });
      return;
    }
    throw error;
  }
  const projectId = scope.projectId;
  const task: AgentTask = {
    id: uuid(),
    projectId,
    sessionId: parsed.data.sessionId ?? projectId,
    agentId: parsed.data.agentId,
    type: parsed.data.type as AgentTask['type'],
    description: transcript.text,   // ← the recognized text becomes the task description
    context: {
      projectId,
      rootPath: '/tmp/code-siren-step-8',
      techStack: {},
      activeFiles: [],
      // Approval-gate fix: pass userId so side-effect-capable agents
      // (Terminal/Operative/Fabrication) can tag their findings. Voice
      // transcripts can target any agent, including gated ones.
      userId: scope.userId,
    },
    priority: 'normal',
    executionMode: parsed.data.executionMode,
    origin: 'voice',                // ← the ONLY field that differs from typed chat
    createdAt: Date.now(),
  };

  // Step 3: Send through the SAME AgentManager.send() — same bus, same events,
  // same trace recorder, same Trust Score governance. No parallel path.
  agentManager.send(task).catch((err) => {
    console.error(`[voice] send failed for ${task.id}:`, err);
  });

  res.status(202).json({
    taskId: task.id,
    agentId: task.agentId,
    origin: task.origin,
    transcript: transcript.text,
    confidence: transcript.confidence,
    status: 'accepted',
    // Return the full task shape so the caller can compare it with a typed task
    taskShape: {
      id: task.id,
      projectId: task.projectId,
      sessionId: task.sessionId,
      agentId: task.agentId,
      type: task.type,
      description: task.description,
      executionMode: task.executionMode,
      priority: task.priority,
      origin: task.origin,
      createdAt: task.createdAt,
    },
  });
});

voiceRouter.get('/health', requireAuth, (_req, res) => {
  res.json({
    voiceClient: { implementation: getVoiceClient().implementation },
  });
});

// ── Phase E Build 2: Voice provider settings ─────────────────────────────
// Mirrors routes/orchestrator.ts:280-322. POST both persists AND applies
// the change at runtime via applyVoiceProvider(next), so the swap takes
// effect immediately without requiring a server restart.

const voiceSettingsSchema = z.object({
  provider: z.enum(['zai', 'kokoro', 'elevenlabs']).optional(),
  kokoroVoice: z.string().optional(),
  kokoroLangCode: z.string().optional(),
  elevenlabsVoiceId: z.string().optional(),
});

voiceRouter.get('/settings', requireAuth, (_req, res) => {
  const settings = getVoiceSettings();
  // Use getVoiceProviders() (runtime-built) so availability reflects current
  // process.env state — e.g. if ELEVENLABS_API_KEY was added to .env since
  // server boot, it shows as available without a restart.
  res.json({
    settings,
    voiceProviders: getVoiceProviders(),
    kokoroVoices: KOKORO_VOICES,
    elevenlabsVoices: ELEVENLABS_VOICES,
  });
});

voiceRouter.post('/settings', requireAuth, async (req, res) => {
  const parsed = voiceSettingsSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid input', issues: parsed.error.issues });
    return;
  }

  // Validate provider against the allowed list (runtime-built so availability
  // is checked fresh)
  const providers = getVoiceProviders();
  if (parsed.data.provider && !providers.find((p) => p.id === parsed.data.provider && p.available)) {
    const unavailable = providers.find((p) => p.id === parsed.data.provider);
    res.status(400).json({
      error: `Invalid or unavailable provider.${unavailable?.reason ? ' ' + unavailable.reason : ''} Allowed: ${providers.filter((p) => p.available).map((p) => p.id).join(', ')}`,
    });
    return;
  }

  // Validate kokoroVoice against KOKORO_VOICES if provider is 'kokoro' and voice is being set
  if (parsed.data.kokoroVoice && !KOKORO_VOICES.find((v) => v.name === parsed.data.kokoroVoice)) {
    res.status(400).json({
      error: `Invalid kokoroVoice. See KOKORO_VOICES for the full list.`,
    });
    return;
  }

  // Validate elevenlabsVoiceId against ELEVENLABS_VOICES if being set
  if (parsed.data.elevenlabsVoiceId && !ELEVENLABS_VOICES.find((v) => v.voice_id === parsed.data.elevenlabsVoiceId)) {
    res.status(400).json({
      error: `Invalid elevenlabsVoiceId. See ELEVENLABS_VOICES for the full list.`,
    });
    return;
  }

  // Persist the patch
  const next = setVoiceSettings(parsed.data);

  // Apply the runtime swap immediately. If this throws (e.g. ZaiTTSProvider
  // construction fails due to missing z-ai SDK), surface as 500 — don't
  // pretend the swap succeeded.
  try {
    await applyVoiceProvider(next);
  } catch (err: any) {
    console.error(`[voice:settings] applyVoiceProvider failed after persist: ${err.message}`);
    res.status(500).json({
      error: `Settings saved but provider swap failed: ${err.message}. The setting will take effect on next server restart.`,
      settings: next,
    });
    return;
  }

  res.json({ settings: next });
});

// POST /api/voice/speak — Phase 3 read-aloud wiring.
// Body: { text: string }
// Returns: { audioBase64, format, sampleRate, durationMs }
//
// This is the endpoint the ChatBubble "Listen" button calls. It uses the
// SAME getTTSProvider() singleton as greeting + agent-response playback —
// no second TTS path, no separate voice client, no z-ai SDK direct call.
//
// The selected TTS provider is whatever the user picked in the API Hub
// Voice API category (Kokoro local / ElevenLabs cloud / OpenAI TTS / Zai).
// The selection is wired through applyVoiceProvider() which swaps the
// active TTSProvider at runtime — so this endpoint always uses the
// currently-selected voice.
voiceRouter.post('/speak', requireAuth, async (req, res) => {
  const text = req.body?.text;
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Missing "text" in body' });
    return;
  }

  try {
    const { getTTSProvider } = await import('../systems/voice/tts-provider.js');
    const tts = getTTSProvider();
    const result = await tts.speak(text);
    res.json({
      audioBase64: result.audioBase64,
      format: result.format,
      sampleRate: result.sampleRate,
      durationMs: result.durationMs,
    });
  } catch (err: any) {
    console.error(`[voice:speak] TTS failed: ${err?.message ?? err}`);
    res.status(500).json({
      error: `TTS failed: ${err?.message ?? String(err)}`,
      suggestedAction: err?.message?.includes('Kokoro')
        ? 'Make sure the Kokoro model is downloaded (API Hub → Voice API → Kokoro → Download).'
        : 'Check that the selected TTS provider is configured and working (API Hub → Voice API).',
    });
  }
});
