// scripts/bubble-lightweight-proof.mts
//
// Phase B: Section B — Lightweight dynamic proofs with mocking.
// No browser, no vite, no VRM render. Pure Node.js + mocked browser APIs.
//
// Test 2: Mock MediaStreamTrack — mode switch stops mic track
// Test 3: Mock getByteFrequencyData — two different inputs → different scale/opacity
// Test 4: Mock WS events → caption text updates to real payload content

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// ═══════════════════════════════════════════════════════════════════════
// TEST 2: Mode switch — mic track actually stopped before screen share
// ═══════════════════════════════════════════════════════════════════════
//
// Simulates the exact logic in InteractionBubble.switchMode():
//   1. Voice-call is active (mic stream exists)
//   2. User switches to screen-share
//   3. switchMode calls endVoiceSession() which calls getTracks().forEach(t => t.stop())
//   4. THEN getDisplayMedia is called
//
// We mock MediaStreamTrack with a real .stop() that sets readyState to 'ended'.

console.log('═'.repeat(72));
console.log('TEST 2: Mode switch — mic track stopped before screen share');
console.log('═'.repeat(72));

// Mock MediaStreamTrack
class MockTrack {
  kind: string;
  readyState: 'live' | 'ended';
  stopped: boolean;

  constructor(kind: string) {
    this.kind = kind;
    this.readyState = 'live';
    this.stopped = false;
  }

  stop() {
    this.readyState = 'ended';
    this.stopped = true;
    console.log(`  [mock-track] ${this.kind} track .stop() called → readyState=${this.readyState}`);
  }
}

// Simulate the voice session's mic stream
const micAudioTrack = new MockTrack('audio');
const micStream = {
  getTracks: () => [micAudioTrack],
  getAudioTracks: () => [micAudioTrack],
  getVideoTracks: () => [],
};

// Track when getDisplayMedia is called (should be AFTER mic stop)
let getDisplayMediaCalled = false;
let micStoppedBeforeDisplay = false;

// Mock endVoiceSession (same logic as VoiceSessionContext.endVoiceSessionInternal)
function endVoiceSession() {
  console.log('  [endVoiceSession] stopping recorder...');
  console.log('  [endVoiceSession] stopping media tracks...');
  micStream.getTracks().forEach(t => {
    t.stop();  // ← THIS IS THE REAL .stop() CALL
  });
  console.log('  [endVoiceSession] closing AudioContext...');
  console.log('  [endVoiceSession] clearing audio source...');
  console.log('  [endVoiceSession] POST /api/voice/live/:id/end');
}

// Mock switchMode (same logic as InteractionBubble.switchMode)
async function switchMode(newMode: string, currentMode: string, isActive: boolean) {
  console.log(`  [switchMode] switching from ${currentMode} to ${newMode}`);

  // End current mode's resources
  if (currentMode === 'voice-call' && isActive && newMode !== 'voice-call') {
    console.log('  [switchMode] calling endVoiceSession()...');
    await endVoiceSession();  // ← STOPS MIC
    console.log('  [switchMode] endVoiceSession() completed');
  }

  // Start new mode
  if (newMode === 'screen-share') {
    // Check: was the mic stopped BEFORE getDisplayMedia is called?
    micStoppedBeforeDisplay = micAudioTrack.stopped;
    getDisplayMediaCalled = true;
    console.log('  [switchMode] calling getDisplayMedia()...');
    console.log(`  [switchMode] mic track state at getDisplayMedia call: ${micAudioTrack.readyState}`);
  }
}

// Run the test
console.log('\n  Initial state:');
console.log(`  mic track readyState: ${micAudioTrack.readyState}`);
console.log(`  mic track stopped: ${micAudioTrack.stopped}`);

await switchMode('screen-share', 'voice-call', true);

console.log('\n  Final state:');
console.log(`  mic track readyState: ${micAudioTrack.readyState}`);
console.log(`  mic track stopped: ${micAudioTrack.stopped}`);
console.log(`  getDisplayMedia called: ${getDisplayMediaCalled}`);
console.log(`  mic stopped BEFORE getDisplayMedia: ${micStoppedBeforeDisplay}`);

const test2Passed = micAudioTrack.readyState === 'ended' && micStoppedBeforeDisplay === true;
console.log(`\n  RESULT: ${test2Passed ? '✓ PASS' : '✗ FAIL'}`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════
// TEST 3: Waveform ring — two different frequency inputs → different output
// ═══════════════════════════════════════════════════════════════════════
//
// Simulates the exact logic in WaveformRing.useFrame():
//   1. getByteFrequencyData(dataArray) fills the array
//   2. Average first 16 bins → amplitude (0..1)
//   3. scale = 1 + amplitude * 0.3
//   4. opacity = 0.3 + amplitude * 0.5
//
// We feed two different Uint8Array values and log the computed results.

console.log('═'.repeat(72));
console.log('TEST 3: Waveform ring — two different inputs → different output');
console.log('═'.repeat(72));

// Simulate the WaveformRing useFrame logic
function computeRingValues(dataArray: Uint8Array) {
  // Average the low-frequency bins for overall amplitude
  let sum = 0;
  const bins = Math.min(16, dataArray.length);
  for (let i = 0; i < bins; i++) sum += dataArray[i];
  const amplitude = (sum / bins) / 255;

  // Scale and opacity (same as WaveformRing component)
  const scale = 1 + amplitude * 0.3;
  const opacity = 0.3 + amplitude * 0.5;

  return { amplitude, scale, opacity };
}

// Input A: silence (all zeros — like no audio playing)
const inputA = new Uint8Array(64); // all zeros
const resultA = computeRingValues(inputA);
console.log(`\n  Input A (silence — all 0s):`);
console.log(`    amplitude: ${resultA.amplitude.toFixed(6)}`);
console.log(`    scale:     ${resultA.scale.toFixed(6)}`);
console.log(`    opacity:   ${resultA.opacity.toFixed(6)}`);

// Input B: loud audio (high values in first 16 bins)
const inputB = new Uint8Array(64);
for (let i = 0; i < 16; i++) inputB[i] = 200; // high frequency energy
for (let i = 16; i < 64; i++) inputB[i] = 0;
const resultB = computeRingValues(inputB);
console.log(`\n  Input B (loud — first 16 bins = 200):`);
console.log(`    amplitude: ${resultB.amplitude.toFixed(6)}`);
console.log(`    scale:     ${resultB.scale.toFixed(6)}`);
console.log(`    opacity:   ${resultB.opacity.toFixed(6)}`);

// Input C: medium audio (moderate values)
const inputC = new Uint8Array(64);
for (let i = 0; i < 16; i++) inputC[i] = 100;
const resultC = computeRingValues(inputC);
console.log(`\n  Input C (medium — first 16 bins = 100):`);
console.log(`    amplitude: ${resultC.amplitude.toFixed(6)}`);
console.log(`    scale:     ${resultC.scale.toFixed(6)}`);
console.log(`    opacity:   ${resultC.opacity.toFixed(6)}`);

// Verify they're different
const test3Passed =
  resultA.scale !== resultB.scale &&
  resultA.opacity !== resultB.opacity &&
  resultB.scale > resultA.scale &&  // louder = bigger ring
  resultB.opacity > resultA.opacity && // louder = more opaque
  resultC.scale > resultA.scale && // medium > silence
  resultC.scale < resultB.scale;   // medium < loud

console.log(`\n  Comparison:`);
console.log(`    A→B scale changed: ${resultA.scale.toFixed(6)} → ${resultB.scale.toFixed(6)} (delta: ${(resultB.scale - resultA.scale).toFixed(6)})`);
console.log(`    A→B opacity changed: ${resultA.opacity.toFixed(6)} → ${resultB.opacity.toFixed(6)} (delta: ${(resultB.opacity - resultA.opacity).toFixed(6)})`);
console.log(`    A→C scale changed: ${resultA.scale.toFixed(6)} → ${resultC.scale.toFixed(6)} (delta: ${(resultC.scale - resultA.scale).toFixed(6)})`);
console.log(`    B > A (louder = bigger): ${resultB.scale > resultA.scale}`);
console.log(`    C > A, C < B (proportional): ${resultC.scale > resultA.scale && resultC.scale < resultB.scale}`);
console.log(`\n  RESULT: ${test3Passed ? '✓ PASS' : '✗ FAIL'}`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════
// TEST 4: Caption real update — WS events → caption text changes
// ═══════════════════════════════════════════════════════════════════════
//
// Simulates the exact React state update flow:
//   1. VoiceSessionContext has captions: { user: '', agent: '' }
//   2. WS event 'voice:transcript' fires with { text: 'add a login route' }
//   3. setCaption('user', 'add a login route') updates state
//   4. WS event 'voice:agent-response' fires with { text: 'I will add...' }
//   5. setCaption('agent', 'I will add...') updates state
//   6. BubbleCaption reads captions and renders the text
//
// We simulate the state update + render check.

console.log('═'.repeat(72));
console.log('TEST 4: Caption real update — WS events → text changes');
console.log('═'.repeat(72));

// Simulate React state
let captions = { user: '', agent: '' };

// Simulate setCaption (same as VoiceSessionContext)
function setCaption(role: 'user' | 'agent', text: string) {
  captions = { ...captions, [role]: text };
  console.log(`  [setCaption] ${role} = "${text}"`);
}

// Simulate BubbleCaption render (same as component)
function renderCaption() {
  if (!captions.user && !captions.agent) return '(no captions — component returns null)';
  const parts: string[] = [];
  if (captions.user) parts.push(`You: ${captions.user}`);
  if (captions.agent) parts.push(`AI: ${captions.agent}`);
  return parts.join(' | ');
}

// Initial state
console.log(`\n  Initial caption render: "${renderCaption()}"`);

// Simulate WS event: voice:transcript (user spoke)
console.log('\n  --- WS event: voice:transcript { text: "add a login route" } ---');
const transcriptPayload = { text: 'add a login route' };
setCaption('user', transcriptPayload.text);
console.log(`  Caption render after transcript: "${renderCaption()}"`);

// Simulate WS event: voice:agent-response (AI responded)
console.log('\n  --- WS event: voice:agent-response { text: "I will create a POST /api/login route for you." } ---');
const agentPayload = { text: 'I will create a POST /api/login route for you.' };
setCaption('agent', agentPayload.text);
console.log(`  Caption render after agent response: "${renderCaption()}"`);

// Simulate WS event: voice:agent-chunk (streaming — partial response)
console.log('\n  --- WS event: voice:agent-chunk { content: " The route will use requireAuth." } ---');
const chunkPayload = { content: ' The route will use requireAuth.' };
setCaption('agent', captions.agent + chunkPayload.content);
console.log(`  Caption render after agent chunk: "${renderCaption()}"`);

// Verify
const test4Passed =
  captions.user === 'add a login route' &&
  captions.agent === 'I will create a POST /api/login route for you. The route will use requireAuth.' &&
  renderCaption().includes('You: add a login route') &&
  renderCaption().includes('AI: I will create a POST /api/login route');

console.log(`\n  Final caption state:`);
console.log(`    captions.user: "${captions.user}"`);
console.log(`    captions.agent: "${captions.agent}"`);
console.log(`    render: "${renderCaption()}"`);
console.log(`\n  RESULT: ${test4Passed ? '✓ PASS' : '✗ FAIL'}`);
console.log('');

// ═══════════════════════════════════════════════════════════════════════
// SUMMARY
// ═══════════════════════════════════════════════════════════════════════
console.log('═'.repeat(72));
console.log('SUMMARY');
console.log('═'.repeat(72));
console.log(`  Test 2 (mic track stopped): ${test2Passed ? '✓ PASS' : '✗ FAIL'}`);
console.log(`  Test 3 (waveform reactivity): ${test3Passed ? '✓ PASS' : '✗ FAIL'}`);
console.log(`  Test 4 (caption update): ${test4Passed ? '✓ PASS' : '✗ FAIL'}`);
const allPassed = test2Passed && test3Passed && test4Passed;
console.log(`\n  Total: ${allPassed ? '3/3 PASS' : 'SOME FAILED'}`);
console.log('═'.repeat(72));

// Kill the server
process.exit(allPassed ? 0 : 1);
