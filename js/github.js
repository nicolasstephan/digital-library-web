// Read access to the private data repo through the GitHub contents API (same approach as fitness-assistant).
// Needs a fine-grained token with "Contents: read" on that one repo; "read and write" lets the site save the
// "want to read" list (want.json), later notes.

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
    if (res.ok) return (await res.text()).trim();
    if (res.status === 401) throw new Error("Token rejected: expired, revoked or mistyped. Create a new one and paste it in Settings.");
    if (res.status === 404 || res.status === 403) throw new Error(await this.diagnose(res.status));
    throw new Error(`GitHub: ${res.status} ${res.statusText}`);
  }

  /** Explains a 404/403: the token works but can't see the repo, or sees it without Contents permission. */
  async diagnose(status) {
    const user = await fetch(`${API}/user`, { headers: this.headers("application/vnd.github+json") }).catch(() => null);
    if (user && user.status === 401) return "Token rejected: expired, revoked or mistyped.";
    const repo = await fetch(`${API}/repos/${this.repo}`, { headers: this.headers("application/vnd.github+json") }).catch(() => null);
    if (repo && repo.status === 404) {
      return `The token can't see "${this.repo}". In the token's settings set Repository access to ` +
        `"Only select repositories" and pick ${this.repo.split("/")[1]} (the default "Public repositories" can't see private repos).`;
    }
    if (repo && repo.ok) {
      return `The token sees "${this.repo}" but may not read its files: give it Repository permissions > Contents: Read-only.`;
    }
    return `GitHub answered ${status} for "${this.repo}"; check the repo name and the token's repository access.`;
  }

  /** A small JSON file at the branch head with its blob sha (needed to write it back); null if it doesn't exist. */
  async file(path) {
    const res = await fetch(`${API}/repos/${this.repo}/contents/${path}?ref=${this.branch}`, {
      headers: this.headers("application/vnd.github+json"), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    const j = await res.json();
    const bytes = Uint8Array.from(atob(j.content.replace(/\n/g, "")), (c) => c.charCodeAt(0));
    return { data: JSON.parse(new TextDecoder().decode(bytes)), sha: j.sha };
  }

  /** Writes a file as one commit (needs "Contents: Read and write"). Throws with .status on failure (403: read-only token, 409: changed meanwhile). */
  async put(path, text, sha, message) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const res = await fetch(`${API}/repos/${this.repo}/contents/${path}`, {
      method: "PUT", headers: this.headers("application/vnd.github+json"),
      body: JSON.stringify({ message, content: btoa(bin), branch: this.branch, ...(sha ? { sha } : {}) }) });
    if (!res.ok) throw Object.assign(new Error(`${path}: ${res.status} ${res.statusText}`), { status: res.status });
    return res.json();
  }

  /** Raw file content at a commit, as a fetch Response (works for files over 1 MB). */
  async raw(path, ref) {
    const url = `${API}/repos/${this.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${ref}`;
    const res = await fetch(url, { headers: this.headers("application/vnd.github.raw+json") });
    if (!res.ok) throw new Error(`${path}: ${res.status} ${res.statusText}`);
    return res;
  }
}
