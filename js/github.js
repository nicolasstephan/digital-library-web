// Read access to the private data repo through the GitHub contents API (same approach as fitness-assistant).
// Needs a fine-grained token with "Contents: read" (later "read and write", for notes) on that one repo.

const API = "https://api.github.com";

export class GitHubRepo {
  constructor({ repo, token, branch = "main" }) {
    this.repo = repo.trim().replace(/^https:\/\/github\.com\//, "").replace(/\/$/, "");
    this.token = token.trim();
    this.branch = branch;
  }

  headers(accept) {
    return {
      Accept: accept,
      Authorization: `Bearer ${this.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  /** Commit sha of the branch head: changes whenever the extractor pushes, so it versions the cache. */
  async headSha() {
    const res = await fetch(`${API}/repos/${this.repo}/commits/${this.branch}`, {
      headers: this.headers("application/vnd.github.sha"),
      cache: "no-store",
    });
    if (res.status === 401) throw new Error("Token rejected (expired or wrong)");
    if (res.status === 404) throw new Error(`Repo "${this.repo}" not found, or the token has no access to it`);
    if (!res.ok) throw new Error(`GitHub: ${res.status} ${res.statusText}`);
    return (await res.text()).trim();
  }

  /** Raw file content at a commit, as a fetch Response (works for files over 1 MB). */
  async raw(path, ref) {
    const url = `${API}/repos/${this.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`;
    const res = await fetch(url, { headers: this.headers("application/vnd.github.raw+json") });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res;
  }
}
