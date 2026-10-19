import type { ProviderAdapter } from './types.js';

export interface ResolvedProvider {
  provider: ProviderAdapter;
  providerName: string;
  effectiveModel: string;
}

export interface ProviderRouterOptions {
  defaultProvider?: string;
}

export class ProviderRouter {
  private adapters = new Map<string, ProviderAdapter>();
  private defaultProviderName: string;

  constructor(options: ProviderRouterOptions = {}) {
    this.defaultProviderName = (options.defaultProvider || 'gemini').toLowerCase();
  }

  register(adapter: ProviderAdapter): this {
    const name = (adapter.providerName || 'gemini').toLowerCase();
    this.adapters.set(name, adapter);
    return this;
  }

  getAdapter(providerName: string): ProviderAdapter | undefined {
    return this.adapters.get(providerName.toLowerCase());
  }

  getRegisteredProviders(): string[] {
    return Array.from(this.adapters.keys());
  }

  resolve(requestedModel?: string): ResolvedProvider | undefined {
    // 1. Model omitted: use default provider and its default model
    if (!requestedModel || requestedModel.trim().length === 0) {
      const defaultAdapter = this.adapters.get(this.defaultProviderName);
      if (!defaultAdapter) {
        // Fall back to first registered adapter if default is not available
        const firstAdapter = this.adapters.values().next().value as ProviderAdapter | undefined;
        if (!firstAdapter) {
          return undefined;
        }
        const provName = firstAdapter.providerName || 'gemini';
        return {
          provider: firstAdapter,
          providerName: provName,
          effectiveModel: firstAdapter.defaultModel || '',
        };
      }
      const provName = defaultAdapter.providerName || this.defaultProviderName || 'gemini';
      return {
        provider: defaultAdapter,
        providerName: provName,
        effectiveModel: defaultAdapter.defaultModel || '',
      };
    }

    const trimmed = requestedModel.trim();

    // 2. Explicit provider prefix (e.g., "openai/gpt-4o", "anthropic/claude-3-5-sonnet", "ollama/llama3", "gemini/gemini-1.5-flash")
    if (trimmed.includes('/')) {
      const slashIndex = trimmed.indexOf('/');
      const prefix = trimmed.substring(0, slashIndex).toLowerCase();
      const modelName = trimmed.substring(slashIndex + 1).trim();

      const adapter = this.adapters.get(prefix);
      if (!adapter) {
        return undefined;
      }
      return {
        provider: adapter,
        providerName: adapter.providerName || prefix,
        effectiveModel: modelName.length > 0 ? modelName : (adapter.defaultModel || ''),
      };
    }

    // 3. Pattern-based routing on bare model name
    const lower = trimmed.toLowerCase();

    // OpenAI models
    if (/^(gpt-|o1-|o3-|chatgpt-|dall-e-|text-embedding-)/i.test(lower)) {
      const adapter = this.adapters.get('openai');
      if (adapter) {
        return { provider: adapter, providerName: adapter.providerName || 'openai', effectiveModel: trimmed };
      }
      return undefined;
    }

    // Anthropic models
    if (/^claude-/i.test(lower)) {
      const adapter = this.adapters.get('anthropic');
      if (adapter) {
        return { provider: adapter, providerName: adapter.providerName || 'anthropic', effectiveModel: trimmed };
      }
      return undefined;
    }

    // Gemini models
    if (/^gemini-/i.test(lower)) {
      const adapter = this.adapters.get('gemini');
      if (adapter) {
        return { provider: adapter, providerName: adapter.providerName || 'gemini', effectiveModel: trimmed };
      }
      return undefined;
    }

    // Ollama open-source models
    if (/^(llama|mistral|mixtral|qwen|phi|deepseek|gemma|codellama|starcoder|vicuna|solar|tinyllama)/i.test(lower)) {
      const adapter = this.adapters.get('ollama');
      if (adapter) {
        return { provider: adapter, providerName: adapter.providerName || 'ollama', effectiveModel: trimmed };
      }
      return undefined;
    }

    // 4. Backward compatibility: If exactly one provider is registered (e.g. in test suites using mockGeminiProvider)
    if (this.adapters.size === 1) {
      const soleAdapter = this.adapters.values().next().value as ProviderAdapter;
      return {
        provider: soleAdapter,
        providerName: soleAdapter.providerName || 'gemini',
        effectiveModel: trimmed,
      };
    }

    // 5. Unknown bare model does not match any provider pattern or prefix: return undefined
    return undefined;
  }
}
