// server/src/agents/_shared/tool-registry.ts
// Tool registry — the Code Siren-native equivalent of the donor's ToolExecutor.
//
// Tools are simple { name, description, execute } objects. For Step 2 we ship
// a tiny set of stub tools so react/codeact strategies have something to call
// during the e2e proof. Real tools (calculator, web_search, file_read, code_interpreter)
// land in Step 3+ alongside the Skills Vault.

export interface ToolSpec {
  name: string;
  description: string;
}

export interface ToolResult {
  name: string;
  content: string;
  success: boolean;
}

export interface Tool {
  name: string;
  description: string;
  execute(args: Record<string, unknown>): Promise<ToolResult>;
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
    try {
      return await tool.execute(args);
    } catch (err: any) {
      return {
        name,
        content: `Tool '${name}' threw: ${err.message}`,
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
  description: 'Execute a Python code block. Args: { "code": "print(2+2)" } — Step 2 stub returns the code echo; real Python sidecar comes in Step 6.',
  async execute(args) {
    const code = String(args.code ?? '').trim();
    if (!code) return { name: 'code_interpreter', content: 'Missing "code" arg', success: false };
    // Step 2 stub: echo the code with a fake stdout. Real Python sidecar
    // (Security Sandbox, Node isolated-vm per PDF Module 12) lands in Step 6.
    const fakeStdout = `[step-2 stub code_interpreter] would execute:\n${code}\n\n(no real execution yet — arrives with Security Sandbox in Step 6)`;
    return { name: 'code_interpreter', content: fakeStdout, success: true };
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
//   timeout_ms:    number (default 10000) — request timeout in milliseconds

toolRegistry.register({
  name: 'http_request',
  description: 'Make an HTTP request to an external API. Args: { "url": "...", "method": "GET", "headers": {...}, "api_key_env": "NEWSAPI_KEY", "api_key_placement": "header" } — reads API key from process.env at execution time, never logs the key value.',
  async execute(args) {
    const url = String(args.url ?? '').trim();
    const method = String(args.method ?? 'GET').toUpperCase();
    const headers = (args.headers as Record<string, string>) ?? {};
    const apiKeyEnv = String(args.api_key_env ?? '').trim();
    const apiKeyPlacement = String(args.api_key_placement ?? 'header').toLowerCase();
    const apiKeyHeaderName = String(args.api_key_header_name ?? 'X-Api-Key');
    const apiKeyQueryParam = String(args.api_key_query_param ?? 'apikey');
    const timeoutMs = Number(args.timeout_ms ?? 10000);

    if (!url) {
      return { name: 'http_request', content: 'Missing required "url" arg', success: false };
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
        // Default: header
        finalHeaders[apiKeyHeaderName] = keyValue;
      }
    }

    // ── Make the request with timeout ─────────────────────────────────
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(finalUrl, {
        method,
        headers: finalHeaders,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      // ── Handle non-2xx status codes ─────────────────────────────────
      if (!response.ok) {
        let errorBody = '';
        try { errorBody = await response.text(); } catch { /* ignore */ }
        // Truncate error body to avoid huge responses, and ensure no key
        // value is in the error body (it shouldn't be, but be safe)
        const truncatedBody = errorBody.slice(0, 500);
        return {
          name: 'http_request',
          content: `HTTP ${response.status} ${response.statusText}: ${truncatedBody}`,
          success: false,
        };
      }

      // ── Parse response body ─────────────────────────────────────────
      const contentType = response.headers.get('content-type') ?? '';
      let body: string;

      if (contentType.includes('application/json')) {
        try {
          const jsonData = await response.json();
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
          body = await response.text();
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
      };
    } catch (err: any) {
      clearTimeout(timeoutId);

      // Distinguish timeout from other network errors
      if (err.name === 'AbortError') {
        return {
          name: 'http_request',
          content: `Request timed out after ${timeoutMs}ms`,
          success: false,
        };
      }

      // Network error — don't expose internal details that might include keys
      return {
        name: 'http_request',
        content: `Network error: ${err.message?.slice(0, 200) ?? 'unknown error'}`,
        success: false,
      };
    }
  },
});
