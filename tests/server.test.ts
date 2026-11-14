import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { createPlugin } from "../server.ts";
import type { GithubApi, GitHubIssue } from "../lib/github-api.ts";

const labels = [
  { name: "stage:20:В работе", color: "f59e0b", description: null },
  { name: "stage:10:Бэклог", color: "64748b", description: null },
  { name: "bug", color: "d73a4a", description: null },
];

const issue: GitHubIssue = {
  number: 13,
  title: "Исправить форму",
  body: "Поля не сохраняются.",
  html_url: "https://github.com/acme/popups/issues/13",
  state: "open",
  labels: [labels[2], labels[0]],
  user: { login: "ivan" },
  comments: 2,
  created_at: "2026-11-14T10:00:00Z",
  updated_at: "2026-11-14T11:00:00Z",
  stageLabels: ["stage:20:В работе"],
  stageState: "stage",
};

function makeApi(overrides: Partial<GithubApi> = {}): GithubApi {
  return {
    listLabels: async () => labels,
    listIssues: async () => [issue],
    getIssue: async () => issue,
    listComments: async () => [],
    createIssue: async () => issue,
    addComment: async () => ({
      id: 1,
      body: "Проверю.",
      html_url: "https://github.com/acme/popups/issues/13#issuecomment-1",
      created_at: "2026-11-14T12:00:00Z",
      user: { login: "ivan" },
    }),
    moveIssueStage: async () => issue,
    ...overrides,
  };
}

function makeHost(remote: string) {
  return createFakePluginHost({
    pluginId: "git-kanban",
    sdk: {
      projects: {
        get: async () => ({ gitRemoteUrl: remote }),
      },
    },
  });
}

test("issues_list maps a BB project remote and returns ordered GitHub stages", async () => {
  const host = makeHost("git@github.com:acme/popups.git");
  let requestedRepository = "";
  await createPlugin(makeApi({
    listLabels: async (repository) => {
      requestedRepository = `${repository.owner}/${repository.name}`;
      return labels;
    },
  }))(host.bb);

  const result = await host.harness.behavior.callRpc("issues_list", { projectId: "project-1" }) as {
    repository: { owner: string; name: string; html_url: string };
    stages: Array<{ name: string; order: number; title: string }>;
    issues: GitHubIssue[];
  };

  assert.equal(requestedRepository, "acme/popups");
  assert.deepEqual(result.repository, {
    owner: "acme",
    name: "popups",
    html_url: "https://github.com/acme/popups",
  });
  assert.deepEqual(result.stages.map(({ order }) => order), [10, 20]);
  assert.deepEqual(result.issues.map(({ number }) => number), [13]);
  await host.harness.lifecycle.dispose();
});

test("issues_list rejects non-GitHub remotes before requesting repository data", async () => {
  const host = makeHost("https://gitlab.com/acme/popups.git");
  let requests = 0;
  await createPlugin(makeApi({
    listLabels: async () => { requests += 1; return labels; },
    listIssues: async () => { requests += 1; return [issue]; },
  }))(host.bb);

  await assert.rejects(
    host.harness.behavior.callRpc("issues_list", { projectId: "project-1" }),
    /GitHub remote/,
  );
  assert.equal(requests, 0);
  await host.harness.lifecycle.dispose();
});
