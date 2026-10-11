import "./test-environment.ts";
import { describe, expect, test } from "bun:test";
import { decide } from "./bypass-guard";

const shell = (command: string) => decide("powershell", { command });

// The commands below are copied verbatim from the session that opened pull request 5639404
// (software-engineer-performance, session c36f4258, 2026-08-26). They are the regression: if the
// guard stops matching these, the same pull request can be opened the same way again.
describe("the route that opened 5639404", () => {
  test("refuses the hand written create", () => {
    const result = shell(
      `cd C:\\Code\\bohemia\\office-bohemia-perf-agent\n$env:PYTHONIOENCODING='utf-8'\naz repos pr create --org https://dev.azure.com/office --project OC --repository office-bohemia --source-branch user/calebzearing/perf-dev-auth-ssr --target-branch master --title "Perf - Server render the dev auth route so it paints before hydration" --description "placeholder" --output json 2>&1 | ConvertFrom-Json | Select-Object pullRequestId, status`,
    );
    expect(result.deny).toBe(true);
    expect(result.reason).toContain("bohemia_pr_create");
  });

  test("refuses the PATCH that carried the real description", () => {
    expect(
      shell(
        `az rest --method PATCH --uri "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullRequests/5639404?api-version=7.1" --resource "499b84ac-1321-427f-aa17-267ca6975798" --headers "Content-Type=application/json" --body "@temp/pr-patch.json" --query "{id:pullRequestId,len:length(description)}" -o json`,
      ).deny,
    ).toBe(true);
  });

  test("refuses it even when the body is a file, so the wording is never in the command", () => {
    expect(
      shell(
        `az rest --method PATCH --uri "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullRequests/5639404?api-version=7.1" --headers "Content-Type=application/json" --body "@temp/pr-patch.json" -o none`,
      ).deny,
    ).toBe(true);
  });

  test("refuses az repos pr update when it carries wording", () => {
    expect(
      shell(`az repos pr update --id 5589928 --description "$d" --output json`).deny,
    ).toBe(true);
    expect(shell(`az repos pr update --id 5589928 --title "Perf - shorter title"`).deny).toBe(true);
  });

  /// Moving --url ahead of --method was enough to walk past the first version of this guard, which
  /// required the method to appear textually before the endpoint.
  test("refuses the same PATCH with the arguments reordered", () => {
    expect(
      shell(
        `az rest --url "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullRequests/5639404?api-version=7.1" --resource "499b84ac" --method PATCH --body "@temp/pr-patch.json"`,
      ).deny,
    ).toBe(true);
  });
});

describe("other spellings of the same bypass", () => {
  test("refuses Invoke-RestMethod", () => {
    expect(
      shell(
        `Invoke-RestMethod -Method Post -Uri "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullrequests?api-version=7.1" -Body $payload`,
      ).deny,
    ).toBe(true);
  });

  test("refuses curl", () => {
    expect(
      shell(`curl -X PATCH https://dev.azure.com/office/OC/_apis/git/repositories/x/pullRequests/1`)
        .deny,
    ).toBe(true);
  });
});

describe("what must keep working", () => {
  test("reading a pull request is untouched", () => {
    expect(shell(`az repos pr show --id 5639404 --org https://dev.azure.com/office -o json`).deny)
      .toBe(false);
  });

  test("listing pull requests is untouched", () => {
    expect(shell(`az repos pr list --repository office-bohemia --status active --top 200`).deny)
      .toBe(false);
  });

  test("a GET against the pull requests endpoint is untouched", () => {
    expect(
      shell(
        `Invoke-RestMethod -Headers $h -Uri "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullrequests/5639404?api-version=7.1"`,
      ).deny,
    ).toBe(false);
  });

  test("uploading a screenshot to an existing pull request is untouched", () => {
    expect(
      shell(
        `Invoke-RestMethod -Method Post -Uri "https://office.visualstudio.com/$proj/_apis/git/repositories/$repo/pullRequests/5634985/attachments/before.png?api-version=7.1-preview.1" -InFile before.png`,
      ).deny,
    ).toBe(false);
  });

  /// Verbatim from the pull request repair agent (session 36a7fff6, 2026-08-26T18:09Z). The first
  /// version of this guard denied this, which would have stopped that agent doing its only job.
  test("resolving review comment threads is untouched", () => {
    expect(
      shell(
        `cd C:\\Code\\bohemia\\office-bohemia-pr-updater\n'{"status":"fixed"}' | Set-Content -Encoding utf8 st.json\nforeach ($id in 71819639, 71870203) {\n az rest --resource 499b84ac --method patch --url "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullRequests/5639404/threads/$id?api-version=7.1" --headers "Content-Type=application/json" --body "@st.json" -o json\n}`,
      ).deny,
    ).toBe(false);
  });

  test("replying to a review comment is untouched", () => {
    expect(
      shell(
        `az rest --resource 499b84ac --method POST --url "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullRequests/5639404/threads/71819639/comments?api-version=7.1" --body "@b1.json"`,
      ).deny,
    ).toBe(false);
  });

  test("casting a vote is untouched", () => {
    expect(
      shell(
        `az rest --method PUT --url "https://dev.azure.com/office/OC/_apis/git/repositories/office-bohemia/pullRequests/5632590/reviewers/me?api-version=7.1" --body "@vote.json"`,
      ).deny,
    ).toBe(false);
  });

  /// The draft flag is silently dropped at create time and has to be set afterwards through exactly
  /// this command, so refusing `az repos pr update` outright would break the documented flow.
  test("setting draft, auto-complete or abandonment is untouched", () => {
    expect(shell(`az repos pr update --id 5639404 --draft true`).deny).toBe(false);
    expect(shell(`az repos pr update --id 5639404 --status abandoned`).deny).toBe(false);
    expect(shell(`az repos pr update --id 5639404 --auto-complete true`).deny).toBe(false);
  });

  test("running the gate by hand is untouched", () => {
    expect(shell(`bohemia check -RepoRoot C:\\Code\\bohemia\\office-bohemia -TargetBranch origin/master`).deny)
      .toBe(false);
  });

  test("bohemia push is allowed", () => {
    expect(shell(`bohemia push -RepoRoot C:\\Code\\bohemia\\office-bohemia -TargetBranch origin/master`).deny)
      .toBe(false);
  });

  test("unresolved direct git push is blocked", () => {
    expect(decide("powershell", { command: "git push unresolved-remote HEAD" }).deny).toBe(true);
  });

  test("non-shell tools are untouched", () => {
    expect(decide("view", { path: "az repos pr create" }).deny).toBe(false);
    expect(decide("bohemia-pr-bohemia_pr_create", { repository: "office-bohemia" }).deny).toBe(false);
  });

  test("a shell call with no command is untouched", () => {
    expect(decide("powershell", {}).deny).toBe(false);
  });
});
