const { LLMProvider } = require('./provider');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/**
 * Anthropic Messages API. Requires a Console-issued API key (this is
 * separate from a claude.ai subscription — see README).
 * No embeddings endpoint is exposed here; pair this with a separate
 * embeddings provider (Voyage AI, OpenAI, or a local model) in config.
 */
class AnthropicProvider extends LLMProvider {
  constructor({ apiKey, model = 'claude-sonnet-4-6' }) {
    super();
    if (!apiKey) throw new Error('AnthropicProvider requires an apiKey');
    this.apiKey = apiKey;
    this.model = model;
  }

  async complete(system, messages, opts = {}) {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': API_VERSION,
      },
      body: JSON.stringify({
        model: this.model,
        system,
        messages,
        max_tokens: opts.maxTokens ?? 1500,
        temperature: opts.temperature ?? 0.4,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Anthropic API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n');
  }

  async embed() {
    throw new Error(
      'Anthropic does not offer an embeddings endpoint. Configure a separate ' +
        'embeddings provider (OpenAI, Ollama, or a custom endpoint) in the Setup tab.'
    );
  }
}

module.exports = { AnthropicProvider };
