/**
 * Every LLM backend (hosted API or local runtime) implements this shape.
 * The rest of the app — retrieval, calibration, consolidation, the review
 * pipeline — only ever talks to this interface, never to a specific vendor
 * SDK. That's what makes the tool provider-agnostic: swapping a config
 * value is enough to move from Claude to GPT to a local Ollama model.
 */
class LLMProvider {
  constructor() {
    /**
     * Whether `embed()` actually works for this backend. Default false so a
     * new provider must opt in — an un-overridden `embed()` that throws is
     * exactly the silent-failure mode this flag exists to catch early.
     * Anthropic leaves it false; the config layer reads it to warn before
     * backfill/review ever start.
     */
    this.supportsEmbeddings = false;
  }

  /**
   * @param {string} system - system prompt
   * @param {{role: 'user'|'assistant', content: string}[]} messages
   * @param {{maxTokens?: number, temperature?: number}} [opts]
   * @returns {Promise<string>} the model's text response
   */
  async complete(system, messages, opts = {}) {
    throw new Error('complete() not implemented');
  }

  /**
   * @param {string} text
   * @returns {Promise<number[]>} embedding vector
   */
  async embed(text) {
    throw new Error('embed() not implemented — configure an embeddings provider');
  }

  /** Cheap connectivity check used by the setup wizard. */
  async testConnection() {
    await this.complete('Reply with the single word: ok', [
      { role: 'user', content: 'ping' },
    ], { maxTokens: 10 });
    return true;
  }
}

module.exports = { LLMProvider };
