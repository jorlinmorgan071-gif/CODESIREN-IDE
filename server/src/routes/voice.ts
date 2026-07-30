// server/src/routes/voice.ts
// Voice API — directive Section 6 + Section 7.
//   POST /api/voice/start         start a voice session
//   POST /api/voice/stop          stop a voice session
//   POST /api/voice/transcript    submit a voice transcript → AgentManager.send()
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

import { Router } from 'express';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { requireAuth } from '../auth/middleware.js';
import { getVoiceClient } from '../systems/voice/voice-client.js';
import { agentManager } from '../orchestration/agent-manager.js';
import type { AgentTask } from '../types.js';

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

  // Step 2: Create an AgentTask with origin: 'voice' — the ONLY difference
  // from a typed chat task. Everything else is identical.
  const projectId = parsed.data.projectId ?? '00000000-0000-0000-0000-000000000000';
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
      userId: req.user?.id,
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
