# Agent Auto-Loader

Code Siren's agent system uses an auto-loader pattern: agents are loaded
automatically at boot by scanning this directory for subdirectories, just
like the Skills Vault scans `server/src/skills/library/` for TOML files.

## How to add a new agent

1. Create a new subdirectory here: `server/src/agents/my-agent/`
2. Create `index.ts` in that directory that exports a class extending `IAgent`:

```typescript
import { IAgent } from '../base-agent.js';
import type { AgentTask, AgentChunk, AgentDomain } from '../../types.js';

export class MyAgent extends IAgent {
  readonly id = 'my-agent';
  readonly name = 'My Agent';
  readonly domain: AgentDomain = 'ARCHITECT';
  readonly icon = 'bot';
  readonly color = '#00BFFF';

  constructor() {
    super(0.8); // trust score
  }

  async *execute(task: AgentTask, signal: AbortSignal): AsyncGenerator<AgentChunk> {
    // Agent implementation — delegate to dispatchStrategy for LLM calls
    yield { type: 'text', content: 'Hello from My Agent!' };
  }
}
```

3. That's it — the auto-loader (`server/src/agents/loader.ts`) will find it
   at boot, instantiate it, and register it with AgentManager. No need to
   touch `server/src/index.ts`.

## Contract

- Each subdirectory (except `_shared/`) must have an `index.ts` file.
- The `index.ts` must export exactly one class that extends `IAgent`.
- The class must be instantiable with no constructor arguments (or with
  optional arguments that default safely).
- If any condition fails, the loader logs a clear warning and skips that
  agent — boot continues without crashing.

## How it works

`server/src/agents/loader.ts`:
1. Scans `server/src/agents/` for subdirectories (excluding `_shared/`)
2. Dynamically imports each `index.ts`
3. Finds the exported class that extends `IAgent`
4. Instantiates it and returns the list
5. `server/src/index.ts` registers each loaded agent with `agentManager.register()`

This mirrors the Skills Vault's `loadLibrarySkills()` pattern.
