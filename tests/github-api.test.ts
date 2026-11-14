import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyIssueStage,
  createGithubApi,
  parseGithubRepository,
  parseStageLabel,
  sortStageLabels,
  type GithubApiRunner,
} from "../lib/github-api.ts";

const repository = { owner: "acme", name: "widget" };

function issue(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Issue",
    body: null,
    html_url: "https://github.com/acme/widget/issues/12",
    state: "open",
    labels: [],
    user: { login: "ivan" },
    comments: 0,
    created_at: "2026-11-14T00:00:00Z",
    updated_at: "2026-11-14T00:00:00Z",
    ...overrides,
  };
}

test("parses HTTPS, SSH URL, and SCP-style GitHub remotes", () => {
  assert.deepEqual(parseGithubRepository("https://github.com/acme/widget.git"), repository);
  assert.deepEqual(parseGithubRepository("ssh://git@github.com/acme/widget.git"), repository);
  assert.deepEqual(parseGithubRepository("git@github.com:acme/widget.git"), repository);
});

test("rejects non-GitHub remotes and malformed repository paths", () => {
  for (const remote of [
    null,
    undefined,
    "https://gitlab.com/acme/widget.git",
    "http://github.com/acme/widget.git",
    "https://user:secret@github.com/acme/widget.git",
    "https://github.com/acme/widget/issues",
    "git@github.com:../widget.git",
  ]) {
    assert.throws(() => parseGithubRepository(remote), /GitHub repository|remote/i);
  }
});

test("parses stage labels and sorts by numeric order then name", () => {
  assert.deepEqual(parseStageLabel("stage:20:In Progress"), { name: "stage:20:In Progress", order: 20, title: "In Progress", color: "64748b" });
  assert.equal(parseStageLabel("bug"), null);
  assert.equal(parseStageLabel("stage:nope:Backlog"), null);
  assert.deepEqual(sortStageLabels([
    { name: "stage:20:Doing", color: "f2c94c" },
    { name: "stage:10:Backlog", color: "cfd3d7" },
    { name: "stage:20:Review", color: "d1a4ff" },
  ]).map(({ name, color }) => [name, color]), [
    ["stage:10:Backlog", "cfd3d7"],
    ["stage:20:Doing", "f2c94c"],
    ["stage:20:Review", "d1a4ff"],
  ]);
});

test("classifies issues with no, one, or multiple stage labels", () => {
  assert.deepEqual(classifyIssueStage([{ name: "bug" }]), { kind: "unstaged", stages: [] });
  assert.deepEqual(classifyIssueStage([{ name: "bug" }, { name: "stage:10:Backlog", color: "64748b" }]), {
    kind: "stage",
    stages: [{ name: "stage:10:Backlog", order: 10, title: "Backlog", color: "64748b" }],
  });
  assert.deepEqual(classifyIssueStage([{ name: "stage:10:Backlog", color: "64748b" }, { name: "stage:20:Doing", color: "f59e0b" }]), {
    kind: "conflict",
    stages: [
      { name: "stage:10:Backlog", order: 10, title: "Backlog", color: "64748b" },
      { name: "stage:20:Doing", order: 20, title: "Doing", color: "f59e0b" },
    ],
  });
});

test("loads paginated Issues of all states and filters pull requests", async () => {
  const calls: string[][] = [];
  const runner: GithubApiRunner = async (args) => {
    calls.push([...args]);
    if (args.at(-1)?.includes("/labels?")) {
      return JSON.stringify([
        [{ name: "bug", color: "d73a4a" }],
        [{ name: "stage:10:Backlog", color: "cfd3d7" }],
      ]);
    }
    return JSON.stringify([[
      { number: 1, title: "Issue", body: "Body", html_url: "https://github.com/acme/widget/issues/1", state: "open", labels: [], user: { login: "ivan" }, comments: 0, created_at: "2026-11-14T00:00:00Z", updated_at: "2026-11-14T00:00:00Z" },
      { number: 3, title: "Closed issue", body: null, html_url: "https://github.com/acme/widget/issues/3", state: "closed", labels: [{ name: "stage:50:Done", color: "22c55e" }], user: { login: "ivan" }, comments: 0, created_at: "2026-11-14T00:00:00Z", updated_at: "2026-11-14T00:00:00Z" },
      { number: 2, title: "Pull request", body: null, html_url: "https://github.com/acme/widget/pull/2", state: "open", labels: [], user: { login: "ivan" }, comments: 0, created_at: "2026-11-14T00:00:00Z", updated_at: "2026-11-14T00:00:00Z", pull_request: { url: "https://api.github.com/repos/acme/widget/pulls/2" } },
    ]]);
  };
  const api = createGithubApi(runner);

  const labels = await api.listLabels(repository);
  const issues = await api.listIssues(repository);

  assert.equal(labels.length, 2);
  assert.deepEqual(issues.map(({ number, state }) => [number, state]), [[1, "open"], [3, "closed"]]);
  assert.ok(calls.every((args) => args.includes("--paginate") && args.includes("--slurp")));
  assert.ok(calls.some((args) => args.includes("repos/acme/widget/issues?state=all&per_page=100")));
});

test("loads paginated comments from GitHub", async () => {
  const comment = {
    id: 44,
    body: "A comment",
    html_url: "https://github.com/acme/widget/issues/12#issuecomment-44",
    created_at: "2026-11-14T00:00:00Z",
    user: { login: "ivan" },
  };
  let call: string[] = [];
  const api = createGithubApi(async (args) => {
    call = [...args];
    return JSON.stringify([[comment]]);
  });

  const comments = await api.listComments(repository, 12);

  assert.equal(comments[0].body, "A comment");
  assert.ok(call.includes("--paginate") && call.includes("--slurp"));
  assert.ok(call.includes("repos/acme/widget/issues/12/comments?per_page=100"));
});

test("creates issue and adds comment through argument-safe gh api calls", async () => {
  const calls: string[][] = [];
  const createdIssue = issue({
    number: 7,
    title: "Need shell-safe title $(touch nope)",
    body: "Line one\nLine two",
    html_url: "https://github.com/acme/widget/issues/7",
    labels: [{ name: "stage:10:Backlog", color: "cfd3d7", description: null }],
  });
  const comment = {
    id: 44,
    body: "Comment with spaces and $(not shell)",
    html_url: "https://github.com/acme/widget/issues/7#issuecomment-44",
    created_at: "2026-11-14T00:00:00Z",
    user: { login: "ivan" },
  };
  const runner: GithubApiRunner = async (args) => {
    calls.push([...args]);
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path === "repos/acme/widget/labels?per_page=100") {
      return JSON.stringify([[{ name: "stage:10:Backlog", color: "cfd3d7" }]]);
    }
    return JSON.stringify(path.endsWith("/comments") ? comment : createdIssue);
  };
  const api = createGithubApi(runner);

  await api.createIssue(repository, { title: createdIssue.title, body: "Line one\nLine two", stageLabel: "stage:10:Backlog" });
  await api.addComment(repository, 7, "Comment with spaces and $(not shell)");

  assert.ok(calls.some((args) => args.includes("--method") && args.includes("POST")));
  assert.ok(calls.some((args) => args.includes(`title=${createdIssue.title}`)));
  assert.ok(calls.some((args) => args.includes("labels[]=stage:10:Backlog")));
  assert.ok(calls.some((args) => args.includes("body=Comment with spaces and $(not shell)")));
  assert.ok(calls.every((args) => args.includes("--hostname") && args.includes("github.com")));
});

test("moving stage atomically replaces stage labels and keeps unrelated labels", async () => {
  const calls: string[][] = [];
  const currentIssue = issue({
    labels: [
      { name: "bug", color: "d73a4a" },
      { name: "stage:10:Backlog", color: "cfd3d7" },
      { name: "priority:high", color: "ff0000" },
    ],
  });
  const runner: GithubApiRunner = async (args) => {
    calls.push([...args]);
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path === "repos/acme/widget/labels?per_page=100") {
      return JSON.stringify([[{ name: "stage:10:Backlog", color: "cfd3d7" }, { name: "stage:20:Doing", color: "f2c94c" }]]);
    }
    if (path === "repos/acme/widget/issues/12") return JSON.stringify(currentIssue);
    if (path === "repos/acme/widget/issues/12/labels" && args.includes("PUT")) {
      const colors = new Map([["bug", "d73a4a"], ["priority:high", "ff0000"], ["stage:20:Doing", "f2c94c"]]);
      currentIssue.labels = args.filter((arg) => arg.startsWith("labels[]=")).map((arg) => {
        const name = arg.slice("labels[]=".length);
        return { name, color: colors.get(name) ?? "" };
      });
      return JSON.stringify(currentIssue.labels);
    }
    return "{}";
  };
  const api = createGithubApi(runner);

  const movedIssue = await api.moveIssueStage(repository, 12, "stage:20:Doing");

  assert.equal(calls.filter((args) => args.includes("PUT") && args.includes("repos/acme/widget/issues/12/labels")).length, 1);
  assert.ok(calls.some((args) => args.includes("labels[]=stage:20:Doing")));
  assert.ok(calls.some((args) => args.includes("labels[]=bug") && args.includes("labels[]=priority:high")));
  assert.equal(calls.some((args) => args.some((arg) => arg.includes("stage:10:Backlog"))), false);
  assert.deepEqual(movedIssue.stageLabels, ["stage:20:Doing"]);
  assert.deepEqual(movedIssue.labels.map(({ name }) => name).sort(), ["bug", "priority:high", "stage:20:Doing"]);
});

test("moving to unstaged removes only current stage labels", async () => {
  const calls: string[][] = [];
  const currentIssue = issue({ labels: [{ name: "bug" }, { name: "stage:20:Doing" }] });
  const runner: GithubApiRunner = async (args) => {
    calls.push([...args]);
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path === "repos/acme/widget/issues/12/labels" && args.includes("PUT")) {
      currentIssue.labels = [{ name: "bug" }];
      return JSON.stringify(currentIssue.labels);
    }
    if (path === "repos/acme/widget/issues/12") return JSON.stringify(currentIssue);
    return "{}";
  };
  const api = createGithubApi(runner);

  const movedIssue = await api.moveIssueStage(repository, 12, null);

  assert.ok(calls.some((args) => args.includes("PUT") && args.includes("repos/acme/widget/issues/12/labels") && args.includes("labels[]=bug")));
  assert.deepEqual(movedIssue.stageLabels, []);
  assert.deepEqual(movedIssue.labels.map(({ name }) => name), ["bug"]);
});

test("a closed Issue can move out of a final stage while preserving its closed state until Actions runs", async () => {
  const currentIssue = issue({
    state: "closed",
    labels: [{ name: "bug", color: "d73a4a" }, { name: "stage:60:Canceled", color: "71717a" }],
  });
  const runner: GithubApiRunner = async (args) => {
    const path = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (path === "repos/acme/widget/labels?per_page=100") {
      return JSON.stringify([[{ name: "stage:30:In Progress", color: "f59e0b" }]]);
    }
    if (path === "repos/acme/widget/issues/12/labels" && args.includes("PUT")) {
      currentIssue.labels = args.filter((arg) => arg.startsWith("labels[]=")).map((arg) => {
        const name = arg.slice("labels[]=".length);
        return { name, color: name === "bug" ? "d73a4a" : "f59e0b" };
      });
      return JSON.stringify(currentIssue.labels);
    }
    if (path === "repos/acme/widget/issues/12") return JSON.stringify(currentIssue);
    return "{}";
  };
  const api = createGithubApi(runner);

  const movedIssue = await api.moveIssueStage(repository, 12, "stage:30:In Progress");

  assert.equal(movedIssue.state, "closed");
  assert.deepEqual(movedIssue.stageLabels, ["stage:30:In Progress"]);
  assert.deepEqual(movedIssue.labels.map(({ name }) => name).sort(), ["bug", "stage:30:In Progress"]);
});

test("rejects an unknown stage label and does not write", async () => {
  const calls: string[][] = [];
  const runner: GithubApiRunner = async (args) => {
    calls.push([...args]);
    const path = args.at(-1) ?? "";
    if (path === "repos/acme/widget/issues/12") return JSON.stringify(issue({ labels: [{ name: "stage:10:Backlog" }] }));
    return JSON.stringify([[{ name: "bug", color: "d73a4a" }]]);
  };
  const api = createGithubApi(runner);

  await assert.rejects(api.moveIssueStage(repository, 12, "stage:20:Doing"), /not configured|stage label/i);
  assert.equal(calls.some((args) => args.includes("--method") && args.includes("POST")), false);
});

test("rejects invalid issue numbers and invalid repository identifiers before API calls", async () => {
  let calls = 0;
  const runner: GithubApiRunner = async () => { calls += 1; return "{}"; };
  const api = createGithubApi(runner);

  await assert.rejects(api.listComments(repository, 0), /issue number/i);
  await assert.rejects(api.listLabels({ owner: "../acme", name: "widget" }), /repository/i);
  assert.equal(calls, 0);
});
