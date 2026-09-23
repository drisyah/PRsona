const API = 'https://api.github.com';

class GitHubClient {
  constructor(token) {
    if (!token) throw new Error('GitHubClient requires a personal access token');
    this.token = token;
  }

  async request(path, opts = {}) {
    const res = await fetch(`${API}${path}`, {
      ...opts,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API error ${res.status} on ${path}: ${body}`);
    }
    return res.json();
  }

  /** Lists open PRs for a repo (owner/repo string). */
  async listOpenPRs(repo) {
    return this.request(`/repos/${repo}/pulls?state=open&per_page=100`);
  }

  /** Raw unified diff for a PR, used as pipeline input. */
  async getPRDiff(repo, prNumber) {
    const res = await fetch(`${API}/repos/${repo}/pulls/${prNumber}`, {
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: 'application/vnd.github.v3.diff',
      },
    });
    if (!res.ok) throw new Error(`GitHub diff fetch error ${res.status}`);
    return res.text();
  }

  /** All review comments a specific user has ever left on a repo's PRs —
   *  used for backfill. Paginates until exhausted. */
  async listUserReviewComments(repo, username, { since } = {}) {
    const all = [];
    let page = 1;
    // Review comments endpoint doesn't filter by author server-side for
    // older API versions, so we filter client-side after fetching.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const qs = new URLSearchParams({
        per_page: '100',
        page: String(page),
        sort: 'created',
        direction: 'desc',
        ...(since ? { since } : {}),
      });
      const batch = await this.request(`/repos/${repo}/pulls/comments?${qs}`);
      if (batch.length === 0) break;
      all.push(...batch.filter((c) => c.user?.login === username));
      if (batch.length < 100) break;
      page += 1;
    }
    return all;
  }

  /** The authenticated account, for verifying a token. */
  async getUser() {
    return this.request('/user');
  }

  /** Posts a pending (UNSUBMITTED) review. The human opens the PR in the
   *  GitHub UI and submits it themselves as a final check.
   *
   *  `event` must be OMITTED to get a pending review. Sending
   *  `event: 'COMMENT'` does the opposite of what it looks like — it
   *  *submits* the review immediately (GitHub: "By leaving this blank, you
   *  set the review action state to PENDING"), and COMMENT additionally
   *  requires a top-level `body`. Omitting it avoids both: the review sits
   *  in PENDING, no `body` is needed, and nothing is submitted or notified
   *  until a human does it. */
  async createPendingReview(repo, prNumber, comments) {
    return this.request(`/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        comments: comments.map((c) => ({
          path: c.file_path,
          line: c.line,
          body: c.text,
        })),
      }),
    });
  }
}

module.exports = { GitHubClient };
