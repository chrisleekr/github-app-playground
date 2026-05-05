import { describe, expect, it, mock } from "bun:test";
import type { Octokit } from "octokit";

import { resolveGithubToken } from "../../src/core/github-token";

function makeOctokit(token: string): Pick<Octokit, "auth"> {
  return {
    auth: mock((params: unknown): Promise<unknown> => {
      expect(params).toEqual({ type: "installation" });
      return Promise.resolve({ token });
    }) as unknown as Octokit["auth"],
  };
}

describe("resolveGithubToken", () => {
  it("returns the PAT verbatim when one is provided, skipping the App mint", async () => {
    const octokit = makeOctokit("ghs_should_not_be_called");
    const result = await resolveGithubToken(octokit, "ghp_pat_value");
    expect(result).toBe("ghp_pat_value");
    expect(octokit.auth).not.toHaveBeenCalled();
  });

  it("falls back to the installation token mint when PAT is undefined", async () => {
    const octokit = makeOctokit("ghs_installation_token");
    const result = await resolveGithubToken(octokit, undefined);
    expect(result).toBe("ghs_installation_token");
    expect(octokit.auth).toHaveBeenCalledTimes(1);
  });

  it("treats empty-string PAT as 'set' and returns it without minting (caller responsible for non-empty values)", async () => {
    // Documents the contract: nonEmptyOptionalString in config strips ""
    // upstream, so this branch never fires in production. The unit test
    // pins the helper's behaviour so a future config relaxation cannot
    // silently flip semantics.
    const octokit = makeOctokit("ghs_should_not_be_called");
    const result = await resolveGithubToken(octokit, "");
    expect(result).toBe("");
    expect(octokit.auth).not.toHaveBeenCalled();
  });
});
