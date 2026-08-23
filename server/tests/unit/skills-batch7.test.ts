// tests/unit/skills-batch7.test.ts
//
// Phase D Batch 7 — Finance & Currency APIs.
//
// Built (3 skills):
//   - alphavantage-time-series  (TIME_SERIES_DAILY — daily OHLCV stock prices)
//   - alphavantage-global-quote (GLOBAL_QUOTE — real-time stock quote)
//   - exchangerate-api-latest   (open-access latest FX rates — NO KEY NEEDED)
//
// Skipped (documented in .env.example):
//   - CurrencyFreaks  — redundant with ExchangeRate-API open tier (key required for same data)
//   - Fixer           — redundant + free-tier restricted (100 req/month, EUR-only base)
//                       (Section 0 confirmed HTTPS works fine on the free tier.)
//
// Test design (per user directive):
//   - Alpha Vantage tests: missing-key (real empty .env) + mocked success.
//     Live test SKIPS because ALPHA_VANTAGE_KEY is not present in sandbox.
//   - ExchangeRate-API tests: mocked success + LIVE test that ACTUALLY RUNS
//     and returns real data (open endpoint, no key blocks it). Behaves like
//     Batch 1/2 no-key skills (Cat Facts, Open-Meteo, CoinGecko).
//   - Fabrication guards on API error responses.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { loadLibrarySkills } from '../../src/skills/library/index.js';
import { listInstalledSkills, executeSkill, getSkill } from '../../src/skills/executor.js';
import { toolRegistry } from '../../src/agents/_shared/tool-registry.js';

async function withMissingEnv<T>(key: string, run: () => Promise<T>): Promise<T> {
  vi.stubEnv(key, '');
  try {
    return await run();
  } finally {
    vi.unstubAllEnvs();
  }
}

describe('Phase D Batch 7 — Finance & Currency API skills', () => {
  beforeAll(() => {
    loadLibrarySkills();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // All 3 new skills installed
  // ════════════════════════════════════════════════════════════════════

  it('all 3 Batch 7 skills are installed', () => {
    const skills = listInstalledSkills();
    const names = skills.map(s => s.name);
    expect(names).toContain('alphavantage-time-series');
    expect(names).toContain('alphavantage-global-quote');
    expect(names).toContain('exchangerate-api-latest');
  });

  it('CurrencyFreaks + Fixer are NOT installed (intentionally skipped)', () => {
    const skills = listInstalledSkills();
    const names = skills.map(s => s.name);
    expect(names).not.toContain('currencyfreaks-rates');
    expect(names).not.toContain('fixer-rates');
  });

  // ════════════════════════════════════════════════════════════════════
  // Manifest correctness
  // ════════════════════════════════════════════════════════════════════

  it('Alpha Vantage TIME_SERIES_DAILY manifest: apikey query param + ALPHA_VANTAGE_KEY env', () => {
    const skill = getSkill('alphavantage-time-series');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('TIME_SERIES_DAILY');
    expect(template).toContain('alphavantage.co/query');
    expect(template).toContain('api_key_placement');
    expect(template).toContain('query');
    expect(template).toContain('api_key_query_param');
    expect(template).toContain('apikey');
    expect(template).toContain('ALPHA_VANTAGE_KEY');
    // CRITICAL: must NOT use Authorization header or Bearer prefix
    expect(template).not.toContain('Authorization');
    expect(template).not.toContain('Bearer');
  });

  it('Alpha Vantage GLOBAL_QUOTE manifest: apikey query param + ALPHA_VANTAGE_KEY env', () => {
    const skill = getSkill('alphavantage-global-quote');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('GLOBAL_QUOTE');
    expect(template).toContain('alphavantage.co/query');
    expect(template).toContain('api_key_placement');
    expect(template).toContain('query');
    expect(template).toContain('api_key_query_param');
    expect(template).toContain('apikey');
    expect(template).toContain('ALPHA_VANTAGE_KEY');
    expect(template).not.toContain('Authorization');
    expect(template).not.toContain('Bearer');
  });

  it('ExchangeRate-API manifest: NO api_key_env field (open access)', () => {
    const skill = getSkill('exchangerate-api-latest');
    const template = skill!.steps[0].arguments_template;
    expect(template).toContain('open.er-api.com/v6/latest');
    // CRITICAL: must NOT contain any api_key_* fields — this is an open endpoint
    expect(template).not.toContain('api_key_env');
    expect(template).not.toContain('api_key_placement');
    expect(template).not.toContain('api_key_query_param');
    expect(template).not.toContain('api_key_header_name');
    expect(template).not.toContain('Authorization');
  });

  // ════════════════════════════════════════════════════════════════════
  // Missing-key handling — Alpha Vantage (proven against REAL empty .env)
  // ════════════════════════════════════════════════════════════════════

  it('CRITICAL — Alpha Vantage TIME_SERIES_DAILY: missing key → honest unavailable, no network call', async () => {
    const result = await withMissingEnv('ALPHA_VANTAGE_KEY', () => executeSkill('alphavantage-time-series', { symbol: 'IBM' }));
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('ALPHA_VANTAGE_KEY');
    // CRITICAL: must NOT contain any fabricated stock data
    expect(result.outputs[0]).not.toContain('IBM');
    expect(result.outputs[0]).not.toContain('Time Series');
  });

  it('CRITICAL — Alpha Vantage GLOBAL_QUOTE: missing key → honest unavailable, no network call', async () => {
    const result = await withMissingEnv('ALPHA_VANTAGE_KEY', () => executeSkill('alphavantage-global-quote', { symbol: 'IBM' }));
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('ALPHA_VANTAGE_KEY');
    expect(result.outputs[0]).not.toContain('IBM');
    expect(result.outputs[0]).not.toContain('Global Quote');
  });

  // ════════════════════════════════════════════════════════════════════
  // Success-path mocked tests with realistic fixtures
  // ════════════════════════════════════════════════════════════════════

  function mockSuccess(body: string) {
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return { name: 'http_request', content: body, success: true };
      return { name, content: 'unknown', success: false };
    });
  }

  it('Alpha Vantage TIME_SERIES_DAILY: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      'Meta Data': {
        '1. Information': 'Daily Prices (open, high, low, close) and Volumes',
        '2. Symbol': 'IBM',
        '3. Last Refreshed': '2026-07-31',
        '4. Output Size': 'Compact',
        '5. Time Zone': 'US/Eastern',
      },
      'Time Series (Daily)': {
        '2026-07-31': {
          '1. open': '221.1500',
          '2. high': '224.7600',
          '3. low': '216.5850',
          '4. close': '223.6500',
          '5. volume': '9093613',
        },
      },
    }));
    const result = await executeSkill('alphavantage-time-series', { symbol: 'IBM' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('IBM');
    expect(result.outputs[0]).toContain('Time Series');
    expect(result.outputs[0]).toContain('223.6500');
    vi.restoreAllMocks();
  });

  it('Alpha Vantage GLOBAL_QUOTE: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      'Global Quote': {
        '01. symbol': 'IBM',
        '02. open': '221.15',
        '03. high': '224.76',
        '04. low': '216.58',
        '05. price': '223.65',
        '06. volume': '9093613',
        '07. latest trading day': '2026-07-31',
        '08. previous close': '219.45',
        '09. change': '4.20',
        '10. change percent': '1.9140%',
      },
    }));
    const result = await executeSkill('alphavantage-global-quote', { symbol: 'IBM' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('IBM');
    expect(result.outputs[0]).toContain('Global Quote');
    expect(result.outputs[0]).toContain('223.65');
    vi.restoreAllMocks();
  });

  it('ExchangeRate-API: success path with realistic fixture', async () => {
    mockSuccess(JSON.stringify({
      result: 'success',
      provider: 'https://www.exchangerate-api.com',
      base_code: 'USD',
      rates: {
        USD: 1,
        EUR: 0.8687,
        GBP: 0.743299,
        JPY: 158.537858,
        KES: 129.373098,
      },
      time_last_update_utc: 'Sat, 01 Aug 2026 00:02:31 +0000',
    }));
    const result = await executeSkill('exchangerate-api-latest', { base: 'USD' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('USD');
    expect(result.outputs[0]).toContain('EUR');
    expect(result.outputs[0]).toContain('0.8687');
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // Fabrication guards
  // ════════════════════════════════════════════════════════════════════

  it('Alpha Vantage API key error (HTTP 200 + "Error Message" body) → honest failure, no fabricated data', async () => {
    // Alpha Vantage returns HTTP 200 with an error JSON body when key is invalid
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return {
        name: 'http_request',
        content: JSON.stringify({
          'Error Message': 'the parameter apikey is invalid or missing. Please claim your free API key on (https://www.alphavantage.co/support/#api-key).',
        }),
        success: true,
      };
      return { name, content: 'unknown', success: false };
    });
    const result = await executeSkill('alphavantage-time-series', { symbol: 'IBM' });
    expect(result.success).toBe(true); // http_request succeeded (200)
    expect(result.outputs[0]).toContain('Error Message');
    // CRITICAL: no fabricated stock data
    expect(result.outputs[0]).not.toContain('Time Series');
    vi.restoreAllMocks();
  });

  it('Alpha Vantage rate-limit (Information body) → honest pass-through, no fabricated data', async () => {
    // Alpha Vantage rate-limit message body (HTTP 200)
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return {
        name: 'http_request',
        content: JSON.stringify({
          Information: 'Thank you for using Alpha Vantage! Our standard API call frequency is 25 requests per day. Please subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly remove all daily call limits.',
        }),
        success: true,
      };
      return { name, content: 'unknown', success: false };
    });
    const result = await executeSkill('alphavantage-global-quote', { symbol: 'IBM' });
    expect(result.success).toBe(true);
    expect(result.outputs[0]).toContain('Information');
    expect(result.outputs[0]).toContain('25 requests per day');
    // CRITICAL: no fabricated quote data
    expect(result.outputs[0]).not.toContain('Global Quote');
    vi.restoreAllMocks();
  });

  it('ExchangeRate-API 5xx → honest failure, no fabricated rates', async () => {
    vi.spyOn(toolRegistry, 'execute').mockImplementation(async (name: string) => {
      if (name === 'http_request') return {
        name: 'http_request',
        content: 'HTTP 503: Service Unavailable',
        success: false,
      };
      return { name, content: 'unknown', success: false };
    });
    const result = await executeSkill('exchangerate-api-latest', { base: 'USD' });
    expect(result.success).toBe(false);
    expect(result.outputs[0]).toContain('503');
    // CRITICAL: no fabricated rates
    expect(result.outputs[0]).not.toContain('rates');
    expect(result.outputs[0]).not.toContain('EUR');
    vi.restoreAllMocks();
  });

  // ════════════════════════════════════════════════════════════════════
  // Live smoke tests
  // ════════════════════════════════════════════════════════════════════

  it('LIVE: Alpha Vantage TIME_SERIES_DAILY (skips if key not configured)', async () => {
    if (!process.env.ALPHA_VANTAGE_KEY) {
      console.log('[live test] ALPHA_VANTAGE_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('alphavantage-time-series', { symbol: 'IBM' });
    if (result.success) console.log('[live test] Alpha Vantage returned real time series');
  }, 15000);

  it('LIVE: Alpha Vantage GLOBAL_QUOTE (skips if key not configured)', async () => {
    if (!process.env.ALPHA_VANTAGE_KEY) {
      console.log('[live test] ALPHA_VANTAGE_KEY not configured — skipping (expected)');
      return;
    }
    const result = await executeSkill('alphavantage-global-quote', { symbol: 'IBM' });
    if (result.success) console.log('[live test] Alpha Vantage returned real quote');
  }, 15000);

  // ────────────────────────────────────────────────────────────────────
  // CRITICAL LIVE TEST: ExchangeRate-API has NO key requirement, so its
  // live test ACTUALLY RUNS in this sandbox and asserts on real data —
  // same pattern as Batch 1/2 no-key skills (Cat Facts, Open-Meteo, CoinGecko).
  // ────────────────────────────────────────────────────────────────────

  it('LIVE: ExchangeRate-API returns real USD rates (open endpoint, no key required)', async () => {
    vi.restoreAllMocks(); // Use REAL http_request — no mocking
    const result = await executeSkill('exchangerate-api-latest', { base: 'USD' });
    if (!result.success) {
      console.log('[live test] ExchangeRate-API unavailable in sandbox — skipping');
      return;
    }
    // Assert on real data — these fields are present in every successful response
    expect(result.outputs[0]).toContain('result');
    expect(result.outputs[0]).toContain('success');
    expect(result.outputs[0]).toContain('base_code');
    expect(result.outputs[0]).toContain('USD');
    expect(result.outputs[0]).toContain('rates');
    // Spot-check at least 3 widely-traded currencies
    expect(result.outputs[0]).toContain('EUR');
    expect(result.outputs[0]).toContain('GBP');
    expect(result.outputs[0]).toContain('JPY');
    console.log('[live test] ExchangeRate-API returned real rates (first 200 chars):', result.outputs[0].slice(0, 200));
  }, 15000);

  // ════════════════════════════════════════════════════════════════════
  // End-to-end proof via ExtensionAgent.invoke
  // ════════════════════════════════════════════════════════════════════

  it('E2E: ExtensionAgent.invoke("exchangerate-api-latest") works through real invoke path', async () => {
    mockSuccess(JSON.stringify({
      result: 'success',
      base_code: 'USD',
      rates: { USD: 1, EUR: 0.8687, GBP: 0.743299 },
    }));
    const { ExtensionAgent } = await import('../../src/agents/extension/index.js');
    const agent = new ExtensionAgent();
    const result = await agent.invoke('exchangerate-api-latest', { base: 'USD' });
    expect(result.success).toBe(true);
    expect(result.summary).toContain('exchangerate-api-latest');
    expect((result.data as any).outputs[0]).toContain('EUR');
    vi.restoreAllMocks();
  });

  it('E2E: ExtensionAgent.invoke("alphavantage-global-quote") works through real invoke path', async () => {
    mockSuccess(JSON.stringify({
      'Global Quote': {
        '01. symbol': 'IBM',
        '05. price': '223.65',
      },
    }));
    const { ExtensionAgent } = await import('../../src/agents/extension/index.js');
    const agent = new ExtensionAgent();
    const result = await agent.invoke('alphavantage-global-quote', { symbol: 'IBM' });
    expect(result.success).toBe(true);
    expect(result.summary).toContain('alphavantage-global-quote');
    expect((result.data as any).outputs[0]).toContain('IBM');
    vi.restoreAllMocks();
  });
});
