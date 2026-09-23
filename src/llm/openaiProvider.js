const { LLMProvider } = require('./provider');

/**
 * OpenAI's hosted API. Also works unmodified against any OpenAI-compatible
 * endpoint if you just override baseUrl — see OpenAICompatProvider for the
 * dedicated version of that (local runtimes, OpenRouter, Together, etc.)
 */
class OpenAIProvider extends LLMProvider {
  constructor({ apiKey, model = 'gpt-4o', embeddingModel = 'text-embedding-3-small', baseUrl = 'https://api.openai.com/v1' }) {
    super();
    if (!apiKey) throw new Error('OpenAIProvider requires an apiKey');
    this.apiKey = apiKey;
    this.model = model;
    this.embeddingModel = embeddingModel;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.supportsEmbeddings = true;
  }

  async complete(system, messages, opts = {}) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [{ role: 'system', content: system }, ...messages],
        max_tokens: opts.maxTokens ?? 1500,
        temperature: opts.temperature ?? 0.4,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  }

  async embed(text) {
    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.embeddingModel, input: text }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.data[0].embedding;
  }
}

module.exports = { OpenAIProvider };
