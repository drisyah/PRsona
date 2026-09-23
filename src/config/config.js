const Store = require('electron-store');

/**
 * All local settings — provider choice, API keys / base URLs, GitHub
 * token, active reviewer. Stored via electron-store, which writes a plain
 * JSON file in the OS's standard app-data location. Secrets here are as
 * safe as the user's OS-level file permissions — same trust model as most
 * local dev tools (e.g. `gh` CLI, git credential files). Documented in the
 * README rather than silently assumed.
 */
const schema = {
  reviewerId: { type: 'string', default: '' },
  githubToken: { type: 'string', default: '' },
  llm: {
    type: 'object',
    default: { provider: 'anthropic', model: 'claude-sonnet-4-6', apiKey: '' },
  },
  embeddings: {
    type: 'object',
    default: null,
  },
  repos: { type: 'array', default: [] },
  strictness: { type: 'number', default: 0.3 },
};

let store = null;

function initConfig() {
  store = new Store({ name: 'config', schema: undefined, defaults: undefined });
  // electron-store's schema validation is strict about types; keep this
  // permissive and just seed defaults if empty, so partial configs don't
  // throw during early setup.
  for (const [key, def] of Object.entries(schema)) {
    if (store.get(key) === undefined) store.set(key, def.default);
  }
  return store;
}

function getConfig() {
  if (!store) throw new Error('Config not initialized — call initConfig() first.');
  return store;
}

module.exports = { initConfig, getConfig };
