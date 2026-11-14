import { execFile } from "node:child_process";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { createGithubApi, parseGithubRepository, sortStageLabels } from "./lib/github-api.ts";
import type { GithubApi } from "./lib/github-api.ts";

const projectIdSchema = z.string().trim().min(1).max(128);
const issueNumberSchema = z.number().int().positive().max(999_999_999);
const threadIdSchema = z.string().trim().min(1).max(256).nullable();
const stageLabelSchema = z.string().regex(/^stage:\d{1,9}:.{1,32}$/).nullable();
const labelSchema = z.object({ name: z.string(), color: z.string(), description: z.string().nullable() });
const stageSchema = z.object({ name: z.string(), order: z.number().int(), title: z.string(), color: z.string() });
const issueSchema = z.object({
  number: issueNumberSchema,
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  labels: z.array(labelSchema),
  user: z.object({ login: z.string() }).nullable(),
  comments: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  pull_request: z.object({ url: z.string().url() }).optional(),
  stageLabels: z.array(z.string()),
  stageState: z.enum(["unstaged", "stage", "conflict"]),
});
const commentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  html_url: z.string().url(),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});
const repositorySchema = z.object({ owner: z.string(), name: z.string(), html_url: z.string().url() });

export const rpcContract = defineRpcContract({
  issues_list: {
    input: z.object({ projectId: projectIdSchema }),
    output: z.object({ repository: repositorySchema, stages: z.array(stageSchema), issues: z.array(issueSchema) }),
  },
  issue_comments: {
    input: z.object({ projectId: projectIdSchema, issueNumber: issueNumberSchema }),
    output: z.object({ comments: z.array(commentSchema) }),
  },
  issue_stage_set: {
    input: z.object({ projectId: projectIdSchema, issueNumber: issueNumberSchema, stageLabel: stageLabelSchema }),
    output: issueSchema,
  },
  issue_comment_add: {
    input: z.object({ projectId: projectIdSchema, issueNumber: issueNumberSchema, body: z.string().trim().min(1).max(65_536) }),
    output: commentSchema,
  },
  issue_create: {
    input: z.object({ projectId: projectIdSchema, title: z.string().trim().min(1).max(256), body: z.string().max(65_536), stageLabel: stageLabelSchema, priorityLabel: z.enum(["priority:high", "priority:medium", "priority:low"]).nullable() }),
    output: issueSchema,
  },
  issue_thread_link_get: {
    input: z.object({ projectId: projectIdSchema, issueNumber: issueNumberSchema }),
    output: z.object({ threadId: threadIdSchema }),
  },
  issue_thread_link_set: {
    input: z.object({ projectId: projectIdSchema, issueNumber: issueNumberSchema, threadId: threadIdSchema }),
    output: z.object({ threadId: threadIdSchema }),
  },
});

function errorMessage(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  if (/does not have a valid GitHub|Only GitHub\.com|one GitHub repository/i.test(message)) {
    return "У BB-проекта должен быть GitHub remote вида https://github.com/owner/repo.git.";
  }
  if (/spawn gh ENOENT|gh: command not found|not installed/i.test(message)) {
    return "GitHub CLI не найден. Установите `gh` и выполните `gh auth login`.";
  }
  if (/not logged in|not authenticated|authentication required|run gh auth login/i.test(message)) {
    return "Войдите в GitHub в терминале командой `gh auth login`.";
  }
  if (/HTTP 401|HTTP 403|Resource not accessible|requires? .*permission/i.test(message)) {
    return "У текущего аккаунта нет прав на этот репозиторий или нужную операцию.";
  }
  if (/HTTP 404|Not Found/i.test(message)) {
    return "Репозиторий или Issue не найден. Проверьте GitHub remote и доступ аккаунта.";
  }
  if (/Stage label is not configured/i.test(message)) {
    return "Эта стадия больше не настроена в GitHub. Обновите доску.";
  }
  return "Не удалось выполнить запрос к GitHub. Проверьте сеть, авторизацию и права доступа.";
}

function readLocalGitRemote(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("git", ["-C", path, "remote", "get-url", "origin"], { timeout: 5_000 }, (error, stdout) => {
      resolve(error ? null : stdout.trim() || null);
    });
  });
}

function toRepository(remote: string | null): { owner: string; name: string; html_url: string } {
  const repository = parseGithubRepository(remote);
  return { ...repository, html_url: `https://github.com/${repository.owner}/${repository.name}` };
}

async function repositoryForProject(bb: BbPluginApi, projectId: string) {
  const project = await bb.sdk.projects.get({ projectId });
  let remote = project.gitRemoteUrl;
  if (!remote) {
    const sources = [...project.sources]
      .filter((source) => source.type === "local_path")
      .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
    for (const source of sources) {
      remote = await readLocalGitRemote(source.path);
      if (remote) break;
    }
  }
  return toRepository(remote);
}

function threadLinkStorageKey(repository: { owner: string; name: string }, issueNumber: number): string {
  return `thread-link:${repository.owner}/${repository.name}#${issueNumber}`;
}

export function createPlugin(github: GithubApi = createGithubApi()) {
  return async (bb: BbPluginApi) => {
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (cause) {
      throw new Error(errorMessage(cause));
    }
  };

  bb.rpc.register(rpcContract, {
    issues_list: async ({ projectId }) => run(async () => {
      const repository = await repositoryForProject(bb, projectId);
      const [labels, issues] = await Promise.all([
        github.listLabels(repository),
        github.listIssues(repository),
      ]);
      return { repository, stages: sortStageLabels(labels), issues };
    }),
    issue_comments: async ({ projectId, issueNumber }) => run(async () => {
      const repository = await repositoryForProject(bb, projectId);
      return { comments: await github.listComments(repository, issueNumber) };
    }),
    issue_stage_set: async ({ projectId, issueNumber, stageLabel }) => run(async () => {
      const repository = await repositoryForProject(bb, projectId);
      return github.moveIssueStage(repository, issueNumber, stageLabel);
    }),
    issue_comment_add: async ({ projectId, issueNumber, body }) => run(async () => {
      const repository = await repositoryForProject(bb, projectId);
      return github.addComment(repository, issueNumber, body);
    }),
    issue_create: async ({ projectId, title, body, stageLabel, priorityLabel }) => run(async () => {
      const repository = await repositoryForProject(bb, projectId);
      return github.createIssue(repository, { title, body, stageLabel, priorityLabel });
    }),
    issue_thread_link_get: async ({ projectId, issueNumber }) => run(async () => {
      const repository = await repositoryForProject(bb, projectId);
      const threadId = await bb.storage.kv.get<string>(threadLinkStorageKey(repository, issueNumber));
      return { threadId: threadId ?? null };
    }),
    issue_thread_link_set: async ({ projectId, issueNumber, threadId }) => run(async () => {
      const repository = await repositoryForProject(bb, projectId);
      const key = threadLinkStorageKey(repository, issueNumber);
      if (threadId) await bb.storage.kv.set(key, threadId);
      else await bb.storage.kv.delete(key);
      return { threadId };
    }),
  });
  };
}

export default createPlugin();
