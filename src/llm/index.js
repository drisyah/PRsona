const { AnthropicProvider } = require('./anthropicProvider');
const { OpenAIProvider } = require('./openaiProvider');
const { OllamaProvider } = require('./ollamaProvider');
const { OpenAICompatProvider } = require('./openaiCompatProvider');

/**
 * Builds a provider instance from a config block shaped like:
 *   { provider: 'anthropic' | 'openai' | 'ollama' | 'openai_compat', ... }
 *
 * `forEmbeddings` matters because the same config block can be read two ways:
 * when it's the dedicated *embeddings* block from Setup, its `model` field
 * means "the embedding model"; when it's the *LLM* block being reused as an
 * embeddings fallback, `model` is a chat model and must NOT be used for
 * embeddings (passing `gpt-4o` to /v1/embeddings is a hard API error).
 * The UI writes `embeddings.model`, which is why this mapping exists — the
 * providers themselves expect `embeddingModel`.
 */
function buildProvider(cfg, { forEmbeddings = false } = {}) {
  if (!cfg || !cfg.provider) {
    throw new Error('LLM config missing "provider" field');
  }

  const embeddingModel = forEmbeddings ? cfg.embeddingModel || cfg.model : cfg.embeddingModel;

  switch (cfg.provider) {
    case 'anthropic':
      return new AnthropicProvider({ apiKey: cfg.apiKey, model: cfg.model });

    case 'openai':
      return new OpenAIProvider({
        apiKey: cfg.apiKey,
        model: cfg.model,
        embeddingModel,
        baseUrl: cfg.baseUrl,
      });

    case 'ollama':
      return new OllamaProvider({
        baseUrl: cfg.baseUrl,
        model: cfg.model,
        embeddingModel,
      });

    case 'openai_compat':
      return new OpenAICompatProvider({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        embeddingModel,
      });

    default:
      throw new Error(`Unknown LLM provider: "${cfg.provider}"`);
  }
}

/**
 * Returns a human-actionable explanation when the resolved embeddings
 * provider cannot actually embed, or null when it's fine.
 *
 * This used to be a silent failure: with no dedicated embeddings block,
 * `buildProviders` fell back to the completion provider, and an Anthropic
 * fallback threw mid-backfill (after comments were already ingested) or
 * mid-review. Surfacing it as data lets callers fail fast *and* lets the
 * Setup tab warn without breaking "Test LLM connection".
 */
function embeddingsProblem(appConfig, embeddingsProvider) {
  if (embeddingsProvider.supportsEmbeddings) return null;

  const chosen = appConfig.embeddings;
  if (chosen && chosen.provider === 'anthropic') {
    return 'Anthropic has no embeddings endpoint. Pick a different Embeddings provider in Setup (OpenAI, Ollama, or a custom endpoint) — leave it as "(same as LLM provider)" only if your LLM provider itself supports embeddings.';
  }
  if (chosen) {
    return `Your "${chosen.provider}" embeddings provider has no model set. Fill in "Embedding model" in Setup (e.g. text-embedding-3-small, or nomic-embed-text for Ollama).`;
  }
  return `Your LLM provider ("${appConfig.llm?.provider || 'unset'}") can't produce embeddings. Set a separate Embeddings provider in Setup — backfill needs it to build the retrieval corpus.`;
}

/**
 * Convenience: build both the completion provider and the embeddings
 * provider from a top-level app config. They may be the same provider
 * instance (if cfg.embeddings is absent, falls back to cfg.llm) or two
 * entirely different backends.
 *
 * `embeddingsError` is a string when the resolved embeddings provider can't
 * embed, null otherwise. Callers that need embeddings (backfill) should
 * throw it before doing any work; callers that can degrade (review) should
 * show it as a warning and continue without retrieval.
 */
function buildProviders(appConfig) {
  const completion = buildProvider(appConfig.llm);
  const embeddings = appConfig.embeddings
    ? buildProvider(appConfig.embeddings, { forEmbeddings: true })
    : buildProvider(appConfig.llm);
  const embeddingsError = embeddingsProblem(appConfig, embeddings);
  return { completion, embeddings, embeddingsError };
}

module.exports = { buildProvider, buildProviders, embeddingsProblem };
