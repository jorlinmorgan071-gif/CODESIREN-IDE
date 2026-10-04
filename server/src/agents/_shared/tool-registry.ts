// server/src/agents/_shared/tool-registry.ts
// Tool registry — the Code Siren-native equivalent of the donor's ToolExecutor.
//
// Tools are simple { name, description, execute } objects. For Step 2 we ship
// a tiny set of stub tools so react/codeact strategies have something to call
// during the e2e proof. Real tools (calculator, web_search, file_read, code_interpreter)
// land in Step 3+ alongside the Skills Vault.

import { requestExternalHttp } from '../../security/egress-policy.js';

export interface ToolSpec {
  name: string;
  description: string;
}

export interface ToolResult {
  name: string;
  content: string;
  success: boolean;
  meta?: Record<string, unknown>;
}

export interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Render the callable tool contract for an agent prompt. Keep this formatter
 * centralized so every execution strategy exposes the same truthful metadata.
 * Tool descriptions are authored alongside their implementations and include
 * argument guidance; no strategy should reduce them to names only.
 */
export function formatToolCatalog(tools: readonly Tool[]): string {
  if (tools.length === 0) return '(none)';
  return tools.map((tool) => `- ${tool.name}: ${tool.description}`).join('\n');
}

class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    console.log(`[tools] registered '${tool.name}'`);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  async execute(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return {
        name,
        content: `Unknown tool: ${name}`,
        success: false,
      };
    }
    return this.executeScoped(tool, args);
  }

  /**
   * Executes a capability created for one authoritative task context. Scoped
   * tools share the registry's error normalization but are never enumerable or
   * callable by global tool name.
   */
  async executeScoped(tool: Tool, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await tool.execute(args);
    } catch (err: any) {
      return {
        name: tool.name,
        content: `Tool '${tool.name}' threw: ${err.message}`,
        success: false,
      };
    }
  }
}

export const toolRegistry = new ToolRegistry();

// ── Built-in stub tools (for Step 2 e2e proof) ───────────────────────────
// These let the react/codeact strategies have something to dispatch to.
// They're deliberately trivial — real implementations come in Step 3+.

toolRegistry.register({
  name: 'calculator',
  description: 'Evaluate a simple arithmetic expression. Args: { "expression": "2+2" }',
  async execute(args) {
    const expr = String(args.expression ?? '').trim();
    if (!expr) return { name: 'calculator', content: 'Missing "expression" arg', success: false };
    // AST-safe eval — only digits, +, -, *, /, ., spaces, parens
    if (!/^[\d+\-*/.() ]+$/.test(expr)) {
      return { name: 'calculator', content: `Invalid expression: ${expr}`, success: false };
    }
    try {
      // eslint-disable-next-line no-new-func
      const result = Function(`"use strict"; return (${expr});`)();
      return { name: 'calculator', content: String(result), success: true };
    } catch (err: any) {
      return { name: 'calculator', content: `Eval error: ${err.message}`, success: false };
    }
  },
});

toolRegistry.register({
  name: 'code_interpreter',
  description: 'Execute a Python code block. Args: { "code": "print(2+2)" } — Unavailable until a real Python sidecar is wired through the security sandbox. Returns success:false with meta.violation="unavailable" so callers cannot mistake it for successful execution.',
  async execute(args) {
    const code = String(args.code ?? '').trim();
    if (!code) return { name: 'code_interpreter', content: 'Missing "code" arg', success: false };
    // D13 closeout — until a real Python sidecar is wired through
    // security/sandbox.ts (which currently executes JS via isolated-vm, not
    // Python), the code_interpreter tool MUST return success:false with
    // meta.violation='unavailable'. This prevents the tool from masquerading
    // as a successful execution when invoked through CodeAct or ReAct.
    //
    // Pre-D13 the stub returned success:true with fabricated stdout like
    // "[step-2 stub] would execute: ..." — that allowed codeact.ts:131 to
    // record `code_interpreter ok` in the trace, implying real execution.
    // Now the trace will honestly record `code_interpreter failed` and the
    // model will see that the tool is unavailable, not that it succeeded.
    return {
      name: 'code_interpreter',
      content: 'code_interpreter is unavailable — no real Python sidecar is wired through the security sandbox. A future phase must wire this to security/sandbox.ts (currently JS-only via isolated-vm) or to a dedicated Python sidecar.',
      success: false,
      meta: { violation: 'unavailable', codePreview: code.slice(0, 200) },
    };
  },
});

toolRegistry.register({
  name: 'think',
  description: 'Reasoning scratchpad. Args: { "thought": "..." } — returns the thought as-is.',
  async execute(args) {
    const thought = String(args.thought ?? '');
    return { name: 'think', content: thought, success: true };
  },
});

// ── http_request tool (Phase D Batch 1 — Foundation) ─────────────────────
// The first tool that makes outbound HTTP calls. All Phase D Skills depend
// on it. Handles API key injection via process.env WITHOUT ever logging the
// key value. Handles timeouts, error status codes, and malformed responses
// honestly — no fabrication on failure.
//
// Args:
//   url:           string (required) — full URL to fetch
//   method:        string (default "GET") — HTTP method
//   headers:       object (optional) — additional headers as key-value pairs
//   api_key_env:   string (optional) — name of env var containing the API key
//   api_key_placement: string (optional) — "header" (default) or "query"
//   api_key_header_name: string (optional) — header name for the key (default "X-Api-Key")
//   api_key_query_param: string (optional) — query param name for the key (default "apikey")
//   api_key_prefix: string (optional) — prepended to header value before injection (e.g. "Bearer ")
//   body:          object (optional) — JSON body for POST requests (JSON-stringified, passed to fetch only when present)
//   timeout_ms:    number (default 10000) — request timeout in milliseconds

toolRegistry.register({
  name: 'http_request',
  description: 'Make an HTTP request to an external API. Args: { "url": "...", "method": "GET", "headers": {...}, "api_key_env": "NEWSAPI_KEY", "api_key_placement": "header", "api_key_prefix": "Bearer ", "body": {...} } — reads API key from process.env at execution time, never logs the key value.',
  async execute(args) {
    const url = String(args.url ?? '').trim();
    const method = String(args.method ?? 'GET').toUpperCase();
    const headers = (args.headers as Record<string, string>) ?? {};
    const apiKeyEnv = String(args.api_key_env ?? '').trim();
    const apiKeyPlacement = String(args.api_key_placement ?? 'header').toLowerCase();
    const apiKeyHeaderName = String(args.api_key_header_name ?? 'X-Api-Key');
    const apiKeyQueryParam = String(args.api_key_query_param ?? 'apikey');
    const apiKeyPrefix = String(args.api_key_prefix ?? '');
    const requestBody = args.body ? JSON.stringify(args.body) : undefined;
    const timeoutMs = Number(args.timeout_ms ?? 10000);

    if (!url) {
      return { name: 'http_request', content: 'Missing required "url" arg', success: false };
    }
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
      return { name: 'http_request', content: `HTTP method ${method} is not allowed`, success: false, meta: { violation: 'unsafe-destination' } };
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
      return { name: 'http_request', content: 'timeout_ms must be between 1 and 30000', success: false, meta: { violation: 'unsafe-destination' } };
    }

    const unsafeHeader = Object.entries(headers).find(([name, value]) => {
      const normalized = name.toLowerCase();
      return !/^[a-z0-9-]+$/i.test(name)
        || /[\r\n]/.test(String(value))
        || ['host', 'connection', 'content-length', 'transfer-encoding', 'cookie'].includes(normalized)
        || normalized.startsWith('proxy-')
        || normalized.startsWith('x-forwarded-');
    });
    if (unsafeHeader) {
      return { name: 'http_request', content: `Header ${unsafeHeader[0]} is not permitted`, success: false, meta: { violation: 'unsafe-destination' } };
    }

    // ── API key handling ──────────────────────────────────────────────
    let finalUrl = url;
    const finalHeaders: Record<string, string> = { ...headers };

    if (apiKeyEnv) {
      const keyValue = process.env[apiKeyEnv];
      if (!keyValue) {
        // Key not configured — refuse to make the call, report clearly
        // WITHOUT revealing the env var name in a way that could be confusing
        return {
          name: 'http_request',
          content: `Skill unavailable: missing ${apiKeyEnv} — add it to server/.env to enable this skill.`,
          success: false,
        };
      }
      // Inject the key WITHOUT ever logging it
      if (apiKeyPlacement === 'query') {
        const separator = finalUrl.includes('?') ? '&' : '?';
        finalUrl = `${finalUrl}${separator}${apiKeyQueryParam}=${encodeURIComponent(keyValue)}`;
      } else {
        // Default: header — prepend prefix if specified (e.g. "Bearer " for GitHub)
        finalHeaders[apiKeyHeaderName] = apiKeyPrefix + keyValue;
      }
    }

    // ── Make the request through the single egress policy ─────────────
    // It validates every destination, pins the transport to the reviewed IP,
    // and revalidates every redirect rather than relying on fetch defaults.
    const sensitiveHeaderNames = apiKeyEnv && apiKeyPlacement !== 'query' ? [apiKeyHeaderName] : [];
    const egress = await requestExternalHttp({
      url: finalUrl,
      method,
      headers: finalHeaders,
      body: requestBody && ['POST', 'PUT', 'PATCH'].includes(method) ? requestBody : undefined,
      timeoutMs,
      sensitiveHeaderNames,
    });
    if (!egress.ok || !egress.response) {
      return {
        name: 'http_request',
        content: `Egress blocked or failed: ${egress.reason ?? 'request could not be completed'}`,
        success: false,
        meta: { violation: egress.violation ?? 'network-error' },
      };
    }
    const response = egress.response;

      // ── Handle non-2xx status codes ─────────────────────────────────
      if (response.status < 200 || response.status >= 300) {
        const errorBody = response.body;
        // Truncate error body to avoid huge responses, and ensure no key
        // value is in the error body (it shouldn't be, but be safe)
        const truncatedBody = errorBody.slice(0, 500);
        return {
          name: 'http_request',
          content: `HTTP ${response.status} ${response.statusText}: ${truncatedBody}`,
          success: false,
          meta: { finalUrl: response.finalUrl, redirectCount: response.redirectCount },
        };
      }

      // ── Parse response body ─────────────────────────────────────────
      const contentType = String(response.headers['content-type'] ?? '');
      let body: string;

      if (contentType.includes('application/json')) {
        try {
          const jsonData = JSON.parse(response.body);
          body = JSON.stringify(jsonData, null, 2);
        } catch {
          return {
            name: 'http_request',
            content: `Response claimed to be JSON but failed to parse. Content-Type: ${contentType}`,
            success: false,
          };
        }
      } else {
        try {
          body = response.body;
        } catch {
          return {
            name: 'http_request',
            content: 'Failed to read response body',
            success: false,
          };
        }
      }

      // Cap body size to avoid huge results in traces/skill outputs
      const cappedBody = body.length > 10000 ? body.slice(0, 10000) + '\n...(truncated)' : body;

      return {
        name: 'http_request',
        content: cappedBody,
        success: true,
        meta: { finalUrl: response.finalUrl, redirectCount: response.redirectCount },
      };
  },
});

// ── UPR Phase 5 — Image Generation tool ─────────────────────────────────
// Registered as a standard tool callable by any agent. Routes through the
// ProviderRegistry to whichever image-video provider is configured.
// The requesting agent writes its own prompt — no intermediary translation.

toolRegistry.register({
  name: 'image_gen',
  description: 'Generate an image from a text prompt using the configured image/video provider (DALL·E, Gemini Imagen, MiniMax, WaveSpeed, or BytePlus Seedream). Args: { "prompt": "description of the image to generate", "size": "1024x1024" (optional) } — the prompt should be a detailed description authored by you as part of your task reasoning. The generated image is returned as base64 data for direct insertion into the file/panel/doc you are working on.',
  async execute(args) {
    const prompt = String(args.prompt ?? '').trim();
    const size = args.size ? String(args.size) : undefined;

    if (!prompt) {
      return { name: 'image_gen', content: 'Missing required "prompt" arg', success: false };
    }

    // Dynamic import to avoid circular dependency at module load time
    const { generateImage } = await import('../../orchestration/image-generation.js');

    const result = await generateImage({ prompt, size });

    if (!result.success) {
      return {
        name: 'image_gen',
        content: result.error ?? 'Image generation failed',
        success: false,
        meta: { provider: result.provider, model: result.model },
      };
    }

    // Return the image data for direct-to-agent delivery.
    // The agent inserts it into whatever it's building (file, panel, doc).
    const imageData = result.imageBase64
      ? `data:image/${result.format};base64,${result.imageBase64}`
      : result.imageUrl ?? '';

    return {
      name: 'image_gen',
      content: imageData,
      success: true,
      meta: {
        provider: result.provider,
        model: result.model,
        format: result.format,
        prompt: prompt.slice(0, 200),
      },
    };
  },
});
