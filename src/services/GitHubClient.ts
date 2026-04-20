import { Octokit } from '@octokit/rest';
import { getProvisioningEnv } from '@/lib/env';
import { assertValidSlug } from '@/lib/slug';

/**
 * Thin wrapper around the GitHub REST API.
 *
 * This is the ONLY file in the codebase that reads GITHUB_TOKEN.
 * Never export the underlying Octokit instance — callers always go through
 * the typed methods below so behaviour is consistent and testable.
 */

export interface CreateRepoResult {
  id: number;
  owner: string; // login of the user or org that owns the new repo
  name: string; // repo name only (no owner prefix)
  fullName: string; // <owner>/<name>
  htmlUrl: string;
  cloneUrl: string; // HTTPS URL — caller must NOT embed the token in this URL
}

export class GitHubClient {
  private octokit: Octokit;
  private org: string;

  constructor() {
    const env = getProvisioningEnv();
    this.octokit = new Octokit({
      auth: env.GITHUB_TOKEN,
      userAgent: 'internal-onboarding-tool',
    });
    this.org = env.GITHUB_ORG;
  }

  get organization(): string {
    return this.org;
  }

  /**
   * Does a repo with this exact name already exist under the target org?
   *
   * Uses a raw HEAD fetch instead of `octokit.repos.get` so a 404 is just a
   * status code — never an Octokit RequestError that gets formatted as
   * "GET /repos/... - 404 with id ... in Xms" and printed by Next.js dev mode
   * logging. The 404 in the slug-check is the HAPPY PATH (means the slug is
   * free); we don't want it polluting the dev console.
   */
  async repoExists(name: string): Promise<boolean> {
    assertValidSlug(name.replace(/^dashboard-/, ''));
    const env = getProvisioningEnv();
    const res = await fetch(`https://api.github.com/repos/${this.org}/${name}`, {
      method: 'HEAD',
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'internal-onboarding-tool',
      },
      cache: 'no-store',
    });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    // Anything else (5xx, rate limit, network) IS an error.
    throw new Error(
      `[github] repoExists probe returned unexpected status ${res.status} for ${name}`,
    );
  }

  /**
   * Has the repo received any commits? Called during push-failure rollback to
   * decide whether deletion is safe.
   *
   * GitHub returns 409 Conflict for `GET /repos/.../commits` on an empty repo.
   */
  async repoHasAnyCommits(name: string): Promise<boolean> {
    try {
      const res = await this.octokit.repos.listCommits({
        owner: this.org,
        repo: name,
        per_page: 1,
      });
      return res.data.length > 0;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 409 || status === 404) return false;
      throw err;
    }
  }

  /**
   * Create a new private repository under `GITHUB_ORG`.
   *
   * If `GITHUB_ORG` actually points to a USER account (not an organization),
   * `POST /orgs/{user}/repos` returns 404 — GitHub treats users and orgs as
   * separate URL namespaces. We detect that case and create the repo under
   * the authenticated user's account instead, after verifying that the
   * authenticated user matches `GITHUB_ORG`. Any other mismatch is a hard
   * failure with a clear "fix your GITHUB_ORG" message.
   */
  async createPrivateRepo(params: {
    name: string;
    description: string;
  }): Promise<CreateRepoResult> {
    assertValidSlug(params.name.replace(/^dashboard-/, ''));

    try {
      const res = await this.octokit.repos.createInOrg({
        org: this.org,
        name: params.name,
        description: params.description,
        private: true,
        has_issues: false,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
      });
      return {
        id: res.data.id,
        owner: res.data.owner.login,
        name: res.data.name,
        fullName: res.data.full_name,
        htmlUrl: res.data.html_url,
        cloneUrl: res.data.clone_url,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;

      // 404 from /orgs/{name}/repos almost always means {name} is a user, not
      // an organization. Verify and fall back to creating under the user.
      if (status === 404) {
        const userInfo = await this.fetchAuthenticatedUserLogin();
        if (userInfo && userInfo.toLowerCase() === this.org.toLowerCase()) {
          const res = await this.octokit.repos.createForAuthenticatedUser({
            name: params.name,
            description: params.description,
            private: true,
            has_issues: false,
            has_wiki: false,
            has_projects: false,
            auto_init: false,
          });
          return {
            id: res.data.id,
            owner: res.data.owner.login,
            name: res.data.name,
            fullName: res.data.full_name,
            htmlUrl: res.data.html_url,
            cloneUrl: res.data.clone_url,
          };
        }
        // Not the user's own account either — misconfigured.
        throw new Error(
          `[github] GITHUB_ORG="${this.org}" was not found as an organization, and the authenticated user is "${userInfo ?? 'unknown'}". ` +
            'Either create a real GitHub organization, or set GITHUB_ORG to your own GitHub username (the username on the PAT).',
        );
      }

      if (status === 401) {
        throw new Error(
          '[github] GITHUB_TOKEN is invalid or expired. Generate a fresh fine-grained PAT and update .env.local.',
        );
      }
      if (status === 403) {
        throw new Error(
          `[github] GITHUB_TOKEN lacks permission to create repos in "${this.org}". The token needs Repository Administration: write (fine-grained) or admin:org + repo (classic). For org-scoped fine-grained PATs, an org owner may need to approve the token.`,
        );
      }
      // Re-throw with the underlying message preserved.
      throw err;
    }
  }

  /** Returns the login of the authenticated user, or null on failure. */
  private async fetchAuthenticatedUserLogin(): Promise<string | null> {
    try {
      const res = await this.octokit.users.getAuthenticated();
      return res.data.login;
    } catch {
      return null;
    }
  }

  /**
   * Invite a GitHub user as a collaborator on a repo.
   *
   * GitHub returns:
   *   201 Created     — invitation sent (user must accept via email)
   *   204 No Content  — already a collaborator, no-op
   *   404             — repo or user not found
   *   422             — validation failed (e.g. user does not exist)
   *   403             — caller is not authorized to add collaborators
   *
   * Owner is the actual repo owner from createPrivateRepo's response — NOT
   * `this.org`, because the create-repo step may have fallen back to
   * createForAuthenticatedUser, which puts the repo under the user account.
   */
  async addCollaborator(params: {
    owner: string;
    repo: string;
    username: string;
    permission: 'pull' | 'triage' | 'push' | 'maintain' | 'admin';
  }): Promise<{ status: 'invited' | 'already-collaborator'; technical?: string }> {
    // Validate the username at the boundary so we never pass garbage to git
    // or the GitHub API. GitHub usernames are alphanumeric + hyphens, max 39
    // chars, cannot start/end with a hyphen, cannot have consecutive hyphens.
    if (!/^[a-zA-Z\d](?:[a-zA-Z\d]|-(?=[a-zA-Z\d])){0,38}$/.test(params.username)) {
      throw new Error(`[github] Invalid GitHub username "${params.username}"`);
    }

    const res = await this.octokit.repos.addCollaborator({
      owner: params.owner,
      repo: params.repo,
      username: params.username,
      permission: params.permission,
    });

    // Octokit returns 201 with a body for new invites and 204 with no body
    // for "already a collaborator". The SDK normalises both, so we look at
    // the response status to disambiguate. Cast through number to satisfy TS
    // narrowing — the SDK's response union only declares 201 but GitHub's docs
    // confirm 204 is possible (existing collaborator, no-op).
    if ((res.status as number) === 204) {
      return { status: 'already-collaborator' };
    }
    return { status: 'invited' };
  }

  /**
   * Delete a repo. Used only for rollback of a failed provision.
   * Requires `delete_repo` on the PAT.
   *
   * Returns true on success, false on 404 (already gone), throws on other
   * errors so the caller can log them loudly.
   */
  async deleteRepo(name: string): Promise<boolean> {
    assertValidSlug(name.replace(/^dashboard-/, ''));
    try {
      await this.octokit.repos.delete({ owner: this.org, repo: name });
      return true;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return false;
      throw err;
    }
  }
}

/** Factory used by services; keeps token reading in one place. */
export function createGitHubClient(): GitHubClient {
  return new GitHubClient();
}
