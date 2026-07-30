// server/src/agents/fabrication/cad.ts
// CAD generation logic — port of the donor's cad_agent.py, re-expressed in
// TypeScript as a native Code Siren module.
//
// Algorithm (matches donor):
//   1. Ask the LLM to write a build123d Python script for the prompt.
//   2. Extract the ```python block.
//   3. Inject the absolute output STL path into the script (replace 'output.stl').
//   4. Send the script to the build123d sidecar via SidecarManager.
//   5. If the script fails, feed the error back to the LLM and retry (max 3).
//   6. On success, return the STL path + size.
//
// The LLM call goes through the existing ModelRouter (single router, no parallel
// inference path). The script execution goes through the build123d Python sidecar
// (spawned and owned by the Node server — see sidecars/manager.ts).

import { modelRouter } from '../../orchestration/model-router.js';
import { sidecarManager, ensureBuild123dSidecar, STL_OUTPUT_DIR } from '../../sidecars/manager.js';
import { addStep, addToolResult, setOutcome } from '../../observability/traces.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuid } from 'uuid';

const SYSTEM_PROMPT = `You are a Python-based 3D CAD engineer using the build123d library.

Your job: write a Python script that generates a 3D model based on the user's
request, then exports it to STL.

Requirements:
1. Start with \`from build123d import *\`.
2. Include \`import numpy as np\` if you use numpy.
3. You MUST assign the final object to a variable named \`result_part\`.
4. If you create a sketch or line, extrude it to make a solid Part.
5. The model should be centered at (0,0,0) and have reasonable dimensions (mm).
6. Use lowercase builder methods: make_face(), extrude(), fillet(), chamfer(), revolve(), loft(), sweep(), offset().
7. Do NOT use PascalCase: MakeFace, Extrude, Fillet, etc. are wrong.
8. The script MUST end with: export_stl(result_part, 'output.stl')
9. Use conservative fillet/chamfer radii (0.5mm to 2mm) to avoid geometry crashes.

Example:
\`\`\`python
from build123d import *

with BuildPart() as p:
    Box(10, 10, 10)
    Fillet(p.edges(), radius=1)

result_part = p.part
export_stl(result_part, 'output.stl')
\`\`\``;

const MAX_RETRIES = 3;

export interface CadGenerationResult {
  success: boolean;
  stlPath?: string;
  stlSize?: number;
  script?: string;
  attempts: number;
  lastError?: string;
}

/**
 * Generate a CAD model from a prompt.
 *
 * @param prompt User's description of the model
 * @param traceId Task ID for trace recording
 * @param onProgress Callback for fabrication:progress events (stage, attempt, message)
 */
export async function generateCad(
  prompt: string,
  traceId: string,
  onProgress: (stage: 'generating-script' | 'executing-script' | 'stl-exported' | 'retrying', attempt: number, message: string) => void,
): Promise<CadGenerationResult> {
  // Ensure the sidecar is running
  ensureBuild123dSidecar();
  if (!existsSync(STL_OUTPUT_DIR)) {
    mkdirSync(STL_OUTPUT_DIR, { recursive: true });
  }

  const jobId = uuid();
  const outputStlPath = join(STL_OUTPUT_DIR, `cad-${jobId}.stl`);

  let currentPrompt = `Write a build123d Python script to create a 3D model of: ${prompt}\n\nEnsure you export to 'output.stl'. Return only the script in a \`\`\`python block.`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    onProgress('generating-script', attempt, `Asking LLM for build123d script (attempt ${attempt}/${MAX_RETRIES})`);
    addStep(traceId, {
      kind: 'llm-call',
      label: `cad attempt ${attempt} — generate build123d script`,
      input: { prompt: currentPrompt.slice(0, 300), attempt },
      meta: { attempt },
    });

    // 1. Ask the LLM for the script
    let rawContent = '';
    try {
      const stream = modelRouter.stream({
        agentId: 'fabrication-agent',
        domain: 'FABRICATION',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: currentPrompt },
        ],
        temperature: 1.0,
        maxTokens: 2048,
        executionMode: 'single-shot',  // CAD script generation is single-shot per attempt
      });
      for await (const chunk of stream) {
        if (chunk.done) break;
        rawContent += chunk.delta;
      }
    } catch (err: any) {
      addStep(traceId, {
        kind: 'error',
        label: `cad attempt ${attempt} — LLM call failed: ${err.message}`,
        meta: { attempt },
      });
      return { success: false, attempts: attempt, lastError: `LLM call failed: ${err.message}` };
    }

    addStep(traceId, {
      kind: 'llm-call',
      label: `cad attempt ${attempt} — script generated (${rawContent.length} chars)`,
      output: rawContent.slice(0, 300),
      meta: { attempt, chars: rawContent.length },
    });

    // 2. Extract the ```python block
    const codeMatch = rawContent.match(/```python\n?([\s\S]*?)```/);
    let script: string;
    if (codeMatch) {
      script = codeMatch[1].trim();
    } else if (rawContent.includes('import build123d') || rawContent.includes('from build123d')) {
      // Fallback: entire text is code
      script = rawContent.trim();
      addStep(traceId, {
        kind: 'parse',
        label: `cad attempt ${attempt} — no \`\`\`python block, using raw text`,
        meta: { attempt },
      });
    } else {
      addStep(traceId, {
        kind: 'error',
        label: `cad attempt ${attempt} — could not extract python code from LLM response`,
        meta: { attempt },
      });
      currentPrompt = `Your previous response did not contain a \`\`\`python block. Please return ONLY a python code block.\n\nOriginal request: ${prompt}`;
      continue;
    }

    // 3. Inject the absolute output STL path
    // Replace 'output.stl' (with or without quotes) with the absolute path.
    // Escape backslashes for Windows paths (not needed on Linux but safe).
    const safePath = outputStlPath.replace(/\\/g, '\\\\');
    script = script.replace(/['"]?output\.stl['"]?/g, `'${safePath}'`);

    addStep(traceId, {
      kind: 'parse',
      label: `cad attempt ${attempt} — script prepared (${script.length} chars, STL target: ${outputStlPath})`,
      meta: { attempt, scriptLength: script.length },
    });

    // 4. Send to the build123d sidecar
    onProgress('executing-script', attempt, `Executing build123d script in sidecar (attempt ${attempt}/${MAX_RETRIES})`);
    addStep(traceId, {
      kind: 'code-exec',
      label: `cad attempt ${attempt} — sending script to build123d sidecar`,
      input: { scriptPreview: script.slice(0, 200), outputStlPath },
      meta: { attempt, sidecar: 'build123d' },
    });

    const execStart = Date.now();
    let resp;
    try {
      resp = await sidecarManager.request('build123d', {
        type: 'execute',
        script,
        output_stl_path: outputStlPath,
      }, 45_000);  // 45s timeout — longer than the sidecar's internal 30s to allow for comms
    } catch (err: any) {
      // Sidecar crashed mid-job — this is the "no hang" guarantee in action
      addStep(traceId, {
        kind: 'error',
        label: `cad attempt ${attempt} — sidecar crashed: ${err.message}`,
        output: { error: err.message, errorName: err.name },
        durationMs: Date.now() - execStart,
        meta: { attempt, sidecarCrash: true },
      });
      addToolResult(traceId, {
        name: 'build123d-sidecar',
        args: { attempt },
        result: `crashed: ${err.message}`,
        success: false,
      });
      // The sidecar is dead — re-raise so the Fabrication Agent surfaces agent:error
      throw err;
    }

    addStep(traceId, {
      kind: 'code-exec',
      label: `cad attempt ${attempt} — sidecar responded ok=${resp.ok}`,
      output: {
        ok: resp.ok,
        error: resp.error,
        stlSize: resp.stl_size,
        stdoutPreview: (resp.stdout as string | undefined)?.slice(0, 200),
        stderrPreview: (resp.stderr as string | undefined)?.slice(0, 200),
      },
      durationMs: Date.now() - execStart,
      meta: { attempt, ok: resp.ok },
    });
    addToolResult(traceId, {
      name: 'build123d-sidecar',
      args: { attempt, scriptLength: script.length },
      result: resp.ok ? `STL ${resp.stl_size} bytes` : `failed: ${resp.error}`,
      success: resp.ok,
    });

    if (resp.ok) {
      // 5. Success — STL produced
      onProgress('stl-exported', attempt, `STL exported (${resp.stl_size} bytes) at ${outputStlPath}`);
      return {
        success: true,
        stlPath: resp.stl_path as string,
        stlSize: resp.stl_size as number,
        script,
        attempts: attempt,
      };
    }

    // 6. Failure — feed error back to LLM and retry
    onProgress('retrying', attempt, `Attempt ${attempt} failed: ${resp.error}`);
    const errLines = (resp.stderr as string | undefined)?.trim().split('\n') ?? [];
    const shortError = errLines.length > 0 ? errLines[errLines.length - 1].slice(0, 200) : (resp.error ?? 'unknown error');
    currentPrompt = `The Python script you generated failed to execute with this error:

${resp.stderr ?? resp.error}

Please fix the code to resolve this error. Return the full corrected script in a \`\`\`python block. Ensure you still export to 'output.stl'.

Original request: ${prompt}`;
    // Loop continues to next attempt
  }

  // All attempts exhausted
  setOutcome(traceId, 'max-turns', `CAD generation failed after ${MAX_RETRIES} attempts`);
  return { success: false, attempts: MAX_RETRIES, lastError: 'All generation attempts failed' };
}
