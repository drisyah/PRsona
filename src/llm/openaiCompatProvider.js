const { LLMProvider } = require('./provider');

/**
 * Catch-all for anything exposing an OpenAI-shaped /v1/chat/completions
 * endpoint: LM Studio, vLLM, llama.cpp's server, text-generation-webui,
 * OpenRouter, Together, Groq, etc. One adapter covers nearly every
 * self-hosted or third-party option because they all converged on this
 * request/response shape.
 */
class OpenAICompatProvider extends LLMProvider {
  constructor({ baseUrl, apiKey = 'not-needed', model, embeddingModel }) {
    super();
    if (!baseUrl) throw new Error('OpenAICompatProvider requires baseUrl');
    if (!model) throw new Error('OpenAICompatProvider requires model');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.model = model;
    this.embeddingModel = embeddingModel; // optional — not every local server supports embeddings
    // Can only embed if we were actually given an embedding model name —
    // without one embed() throws, so don't advertise support up front.
    this.supportsEmbeddings = Boolean(embeddingModel);
  }

  async complete(system, messages, opts = {}) {
    // Gemini's thinking tokens count against max_tokens, so dynamic thinking
    // can guillotine a long reply (we hit exactly that: a findings array cut
    // mid-object → "Could not find closing bracket"). Pin the effort where we
    // know the parameter: off on 2.5 (Google allows disabling), lowest on 3.x
    // (thinking cannot be disabled there). Other endpoints never see it.
    let reasoningEffort;
    if (/^gemini-2\.5/.test(this.model)) reasoningEffort = 'none';
    else if (/^gemini-3/.test(this.model)) reasoningEffort = 'low';

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
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI-compatible endpoint error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.choices[0].message.content;
  }

  async embed(text) {
    if (!this.embeddingModel) {
      throw new Error(
        'No embeddingModel configured for this endpoint. Set llm.embeddings.model ' +
          'in config, or point embeddings at a different provider.'
      );
    }
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
      throw new Error(`Embeddings error ${res.status}: ${body}`);
    }

    const data = await res.json();
    return data.data[0].embedding;
  }
}

module.exports = { OpenAICompatProvider };
