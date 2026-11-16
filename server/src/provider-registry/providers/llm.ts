// server/src/provider-registry/providers/llm.ts
//
// Seed definitions for LLM providers.
// Extracted from registry.ts (task 04 — split god files).
// Each entry is a ProviderRegistryEntry with an empty models[] array —
// the "Test & load" action populates it at runtime from the provider's
// real /models endpoint.

import { config } from '../../config.js';
import type { ProviderRegistryEntry } from '../types.js';

// ── Provider default URLs ───────────────────────────────────────────────
const OPENROUTER_DEFAULT_URL = 'https://openrouter.ai/api/v1';
const ANTHROPIC_DEFAULT_URL = 'https://api.anthropic.com/v1';
const OPENAI_DEFAULT_URL = 'https://api.openai.com/v1';
const GEMINI_DEFAULT_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GROQ_DEFAULT_URL = 'https://api.groq.com/openai/v1';
const DEEPSEEK_DEFAULT_URL = 'https://api.deepseek.com/v1';
const MOONSHOT_DEFAULT_URL = 'https://api.moonshot.cn/1';        // Kimi
const QWEN_DEFAULT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1';  // Alibaba Cloud
const ZHIPU_DEFAULT_URL = 'https://open.bigmodel.cn/api/paas/v4';  // GLM by ZAI
const MISTRAL_DEFAULT_URL = 'https://api.mistral.ai/v1';
const STEPFUN_DEFAULT_URL = 'https://api.stepfun.com/v1';
const BYTEPLUS_DEFAULT_URL = 'https://ark.cn-beijing.volces.com/api/v3';  // ModelArk
const MINIMAX_LLM_DEFAULT_URL = 'https://api.minimax.chat/v1';
const XIAOMI_DEFAULT_URL = 'https://api.mimo.xiaomi.com/v1';      // MiMo
const LMSTUDIO_DEFAULT_URL = 'http://127.0.0.1:1234/v1';          // Local
const KILOCODE_DEFAULT_URL = 'https://code.kilocode.ai/api/v1';

// ── Seed entries ────────────────────────────────────────────────────────

export function seedLlmProviders(): ProviderRegistryEntry[] {
  return [
{
      id: 'openrouter',
      category: 'llm',
      displayName: 'OpenRouter (Cloud Gateway)',
      defaultApiUrl: OPENROUTER_DEFAULT_URL,
      apiUrl: OPENROUTER_DEFAULT_URL,
      apiKey: config.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEY || '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
    },
    {
      id: 'anthropic',
      category: 'llm',
      displayName: 'Anthropic (Direct API)',
      defaultApiUrl: ANTHROPIC_DEFAULT_URL,
      apiUrl: ANTHROPIC_DEFAULT_URL,
      apiKey: config.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY || '',
      connectionTested: false,
      models: [],
      voices: [],
      tools: [],
      imageModels: [],
      lastError: null,
      lastLoadedAt: null,
      infoEndpoints: [],
      lastHealthCheckAt: null,
      healthy: false,
      suggestedAction: null,
      isCustom: false,
    },

    

    // All are OpenAI-compatible (they expose /v1/chat/completions + /v1/models).
    // The "Test & load" action hits their real /models endpoint.
    {
      id: 'openai',
      category: 'llm',
      displayName: 'OpenAI (Codex / GPT)',
      defaultApiUrl: OPENAI_DEFAULT_URL,
      apiUrl: OPENAI_DEFAULT_URL,
      apiKey: config.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'gemini',
      category: 'llm',
      displayName: 'Google · Gemini',
      defaultApiUrl: GEMINI_DEFAULT_URL,
      apiUrl: GEMINI_DEFAULT_URL,
      apiKey: config.GEMINI_API_KEY || process.env.GEMINI_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'groq',
      category: 'llm',
      displayName: 'Groq (Ultra-fast inference)',
      defaultApiUrl: GROQ_DEFAULT_URL,
      apiUrl: GROQ_DEFAULT_URL,
      apiKey: config.GROQ_API_KEY || process.env.GROQ_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'deepseek',
      category: 'llm',
      displayName: 'DeepSeek',
      defaultApiUrl: DEEPSEEK_DEFAULT_URL,
      apiUrl: DEEPSEEK_DEFAULT_URL,
      apiKey: config.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'moonshot',
      category: 'llm',
      displayName: 'Moonshot AI · Kimi',
      defaultApiUrl: MOONSHOT_DEFAULT_URL,
      apiUrl: MOONSHOT_DEFAULT_URL,
      apiKey: config.MOONSHOT_API_KEY || process.env.MOONSHOT_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'qwen',
      category: 'llm',
      displayName: 'Alibaba Cloud · Qwen',
      defaultApiUrl: QWEN_DEFAULT_URL,
      apiUrl: QWEN_DEFAULT_URL,
      apiKey: config.QWEN_API_KEY || process.env.QWEN_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'zhipu',
      category: 'llm',
      displayName: 'Zhipu AI · GLM (by ZAI)',
      defaultApiUrl: ZHIPU_DEFAULT_URL,
      apiUrl: ZHIPU_DEFAULT_URL,
      apiKey: config.ZHIPU_API_KEY || process.env.ZHIPU_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'mistral',
      category: 'llm',
      displayName: 'Mistral AI',
      defaultApiUrl: MISTRAL_DEFAULT_URL,
      apiUrl: MISTRAL_DEFAULT_URL,
      apiKey: config.MISTRAL_API_KEY || process.env.MISTRAL_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'stepfun',
      category: 'llm',
      displayName: 'StepFun',
      defaultApiUrl: STEPFUN_DEFAULT_URL,
      apiUrl: STEPFUN_DEFAULT_URL,
      apiKey: config.STEPFUN_API_KEY || process.env.STEPFUN_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'byteplus',
      category: 'llm',
      displayName: 'BytePlus · ModelArk',
      defaultApiUrl: BYTEPLUS_DEFAULT_URL,
      apiUrl: BYTEPLUS_DEFAULT_URL,
      apiKey: config.BYTEPLUS_API_KEY || process.env.BYTEPLUS_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'minimax-llm',
      category: 'llm',
      displayName: 'MiniMax (LLM)',
      defaultApiUrl: MINIMAX_LLM_DEFAULT_URL,
      apiUrl: MINIMAX_LLM_DEFAULT_URL,
      apiKey: config.MINIMAX_API_KEY || process.env.MINIMAX_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'xiaomi',
      category: 'llm',
      displayName: 'Xiaomi · MiMo',
      defaultApiUrl: XIAOMI_DEFAULT_URL,
      apiUrl: XIAOMI_DEFAULT_URL,
      apiKey: config.XIAOMI_API_KEY || process.env.XIAOMI_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'lmstudio',
      category: 'llm',
      displayName: 'LM Studio (Local)',
      defaultApiUrl: LMSTUDIO_DEFAULT_URL,
      apiUrl: LMSTUDIO_DEFAULT_URL,
      apiKey: config.LMSTUDIO_API_KEY || process.env.LMSTUDIO_API_KEY || 'lm-studio', // LM Studio accepts any string
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    },
    {
      id: 'kilocode',
      category: 'llm',
      displayName: 'Kilo Code',
      defaultApiUrl: KILOCODE_DEFAULT_URL,
      apiUrl: KILOCODE_DEFAULT_URL,
      apiKey: config.KILOCODE_API_KEY || process.env.KILOCODE_API_KEY || '',
      connectionTested: false,
      models: [], voices: [], tools: [], imageModels: [],
      lastError: null, lastLoadedAt: null, infoEndpoints: [],
      lastHealthCheckAt: null, healthy: false, suggestedAction: null, isCustom: false,
    }
  ];
}
