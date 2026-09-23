const { LLMProvider } = require('./provider');

/**
 * Local models served by Ollama (https://ollama.com). No API key, no
 * network egress — everything stays on the user's machine. Requires the
 * user to have `ollama pull <model>` already, and Ollama running locally
 * (default http://localhost:11434).
 */
class OllamaProvider extends LLMProvider {
  constructor({ baseUrl = 'http://localhost:11434', model = 'qwen2.5-coder:32b', embeddingModel = 'nomic-embed-text' }) {
    super();
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
    this.embeddingModel = embeddingModel;
    this.supportsEmbeddings = true;
  }

  async complete(system, messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...messages],
        stream: false,
        options: {
          num_predict: opts.maxTokens ?? 1500,
          temperature: opts.temperature ?? 0.4,
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Ollama error ${res.status}: ${body}\n` +
          `Is Ollama running, and has "ollama pull ${this.model}" been run?`
      );
    }

    const data = await res.json();
    return data.message.content;
  }

  async embed(text) {
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.embeddingModel, prompt: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama embeddings error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.embedding;
  }
}

module.exports = { OllamaProvider };
