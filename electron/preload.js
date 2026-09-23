const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    set: (partial) => ipcRenderer.invoke('config:set', partial),
  },
  // Per-step self-tests — each validates the values currently in the form.
  llm: {
    test: (llm) => ipcRenderer.invoke('llm:test', llm),
  },
  emb: {
    test: (llm, embeddings) => ipcRenderer.invoke('emb:test', { llm, embeddings }),
  },
  github: {
    verify: (token) => ipcRenderer.invoke('github:verify', token),
  },
  shell: {
    open: (url) => ipcRenderer.invoke('shell:open', url),
  },
  reviewer: {
    create: (id, displayName) => ipcRenderer.invoke('reviewer:create', { id, displayName }),
    list: () => ipcRenderer.invoke('reviewer:list'),
  },
  profile: {
    get: (reviewerId) => ipcRenderer.invoke('profile:get', reviewerId),
  },
  // Live counters for the Pull Requests dashboard's status strip.
  stats: {
    overview: (reviewerId) => ipcRenderer.invoke('stats:overview', reviewerId),
  },
  categories: {
    list: () => ipcRenderer.invoke('categories:list'),
  },
  backfill: {
    run: (reviewerId, username, repos) =>
      ipcRenderer.invoke('backfill:run', { reviewerId, username, repos }),
    onProgress: (cb) => ipcRenderer.on('backfill:progress', (e, msg) => cb(msg)),
  },
  prs: {
    listOpen: (repo) => ipcRenderer.invoke('prs:listOpen', { repo }),
  },
  review: {
    run: (reviewerId, repo, prNumber) =>
      ipcRenderer.invoke('review:run', { reviewerId, repo, prNumber }),
    sessions: (reviewerId) => ipcRenderer.invoke('review:sessions', reviewerId),
    drafts: (sessionId) => ipcRenderer.invoke('review:drafts', sessionId),
    resolveDraft: (draftId, reviewerId, action, editedText, deltaType) =>
      ipcRenderer.invoke('review:resolveDraft', { draftId, reviewerId, action, editedText, deltaType }),
    addHumanComment: (sessionId, reviewerId, filePath, line, text, category) =>
      ipcRenderer.invoke('review:addHumanComment', { sessionId, reviewerId, filePath, line, text, category }),
    submitToGitHub: (repo, prNumber, comments, sessionId) =>
      ipcRenderer.invoke('review:submitToGitHub', { repo, prNumber, comments, sessionId }),
  },
  consolidate: {
    propose: (reviewerId) => ipcRenderer.invoke('consolidate:propose', { reviewerId }),
    apply: (proposedProfile, correctionIds) =>
      ipcRenderer.invoke('consolidate:apply', { proposedProfile, correctionIds }),
  },
});
