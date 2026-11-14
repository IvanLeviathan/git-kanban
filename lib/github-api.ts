import { execFile } from "node:child_process";
import { z } from "zod";

const repositoryNamePattern = /^[A-Za-z0-9_.-]+$/;
const stageLabelPattern = /^stage:(\d{1,9}):(.+)$/;
const issueNumberPattern = /^[1-9]\d{0,8}$/;

const githubLabelSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.string().default(""),
  description: z.string().nullable().optional().transform((description) => description ?? null),
});

const githubIssueSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable(),
  html_url: z.string().url(),
  state: z.enum(["open", "closed"]),
  labels: z.array(githubLabelSchema),
  user: z.object({ login: z.string() }).nullable(),
  comments: z.number().int().nonnegative(),
  created_at: z.string(),
  updated_at: z.string(),
  pull_request: z.object({ url: z.string().url() }).optional(),
});

const githubCommentSchema = z.object({
  id: z.number().int().positive(),
  body: z.string(),
  html_url: z.string().url(),
  created_at: z.string(),
  user: z.object({ login: z.string() }).nullable(),
});

const issueCreateResultSchema = githubIssueSchema;

export type GithubRepository = { owner: string; name: string };
export type GitHubLabel = z.infer<typeof githubLabelSchema>;
export type GitHubComment = z.infer<typeof githubCommentSchema>;
export type IssueStageState = "unstaged" | "stage" | "conflict";
export type StageLabel = { name: string; order: number; title: string; color: string };
type StageLabelSource = Pick<GitHubLabel, "name"> & Partial<Pick<GitHubLabel, "color">>;
export type GitHubIssue = z.infer<typeof githubIssueSchema> & {
  stageLabels: string[];
  stageState: IssueStageState;
};

export type GithubApiRunner = (args: readonly string[]) => Promise<string>;

export interface GithubApi {
  listLabels(repository: GithubRepository): Promise<GitHubLabel[]>;
  listIssues(repository: GithubRepository): Promise<GitHubIssue[]>;
  getIssue(repository: GithubRepository, issueNumber: number): Promise<GitHubIssue>;
  listComments(repository: GithubRepository, issueNumber: number): Promise<GitHubComment[]>;
  createIssue(repository: GithubRepository, input: { title: string; body: string; stageLabel?: string | null; priorityLabel?: string | null }): Promise<GitHubIssue>;
  addComment(repository: GithubRepository, issueNumber: number, body: string): Promise<GitHubComment>;
  moveIssueStage(repository: GithubRepository, issueNumber: number, targetStageLabel: string | null): Promise<GitHubIssue>;
}

export function parseGithubRepository(remote: string | null | undefined): GithubRepository {
  if (!remote || remote.length > 2048) {
    throw new Error("Project does not have a valid GitHub repository remote.");
  }

  let path: string;
  const scpRemote = /^git@github\.com:([^?#]+)$/i.exec(remote);

  if (scpRemote) {
    path = scpRemote[1];
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new Error("Project does not have a valid GitHub repository remote.");
    }

    if (
      url.hostname.toLowerCase() !== "github.com"
      || !["https:", "ssh:"].includes(url.protocol)
      || (url.port !== "" && url.port !== "443")
      || url.password !== ""
      || (url.username !== "" && url.username !== "git")
      || url.search !== ""
      || url.hash !== ""
    ) {
      throw new Error("Only GitHub.com repository remotes are supported.");
    }

    path = url.pathname.replace(/^\/+/, "");
  }

  path = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  const [owner, name, ...rest] = path.split("/");
  if (!owner || !name || rest.length > 0 || !isRepositorySegment(owner) || !isRepositorySegment(name)) {
    throw new Error("Project remote must point to one GitHub repository.");
  }

  return { owner, name };
}

function isRepositorySegment(value: string): boolean {
  return repositoryNamePattern.test(value) && value !== "." && value !== "..";
}

export function parseStageLabel(name: string, color = "64748b"): StageLabel | null {
  const match = stageLabelPattern.exec(name);
  if (!match) return null;

  const order = Number(match[1]);
  const title = match[2].trim();
  if (!Number.isSafeInteger(order) || title.length === 0 || title.length > 32 || title.includes("\n")) return null;

  return { name, order, title, color };
}

export function sortStageLabels(labels: readonly StageLabelSource[]): StageLabel[] {
  return labels
    .map(({ name, color }) => parseStageLabel(name, color))
    .filter((label): label is StageLabel => label !== null)
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title));
}

export function classifyIssueStage(labels: readonly StageLabelSource[]): {
  kind: IssueStageState;
  stages: StageLabel[];
} {
  const stages = sortStageLabels(labels);
  return {
    kind: stages.length === 0 ? "unstaged" : stages.length === 1 ? "stage" : "conflict",
    stages,
  };
}

function issueNumberPath(issueNumber: number): string {
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1 || !issueNumberPattern.test(String(issueNumber))) {
    throw new Error("Issue number must be a positive integer.");
  }
  return String(issueNumber);
}

function repositoryPath(repository: GithubRepository): string {
  if (!repository || !isRepositorySegment(repository.owner) || !isRepositorySegment(repository.name)) {
    throw new Error("A valid GitHub repository is required.");
  }
  return `repos/${repository.owner}/${repository.name}`;
}

function validateStageLabel(name: string): StageLabel {
  const stage = parseStageLabel(name);
  if (!stage) throw new Error("Stage label must use the format stage:<number>:<name>.");
  return stage;
}

function parseJson<T>(output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new Error("GitHub returned invalid JSON.");
  }
}

function flattenPages<T>(value: unknown): T[] {
  if (!Array.isArray(value)) throw new Error("GitHub returned an unexpected paginated response.");
  if (value.length === 0) return [];
  return (Array.isArray(value[0]) ? value.flat() : value) as T[];
}

function addStageInfo(issue: z.infer<typeof githubIssueSchema>): GitHubIssue {
  const stage = classifyIssueStage(issue.labels);
  return {
    ...issue,
    stageLabels: stage.stages.map(({ name }) => name),
    stageState: stage.kind,
  };
}

function validateIssueTitle(title: string): string {
  const trimmedTitle = title.trim();
  if (trimmedTitle.length === 0 || trimmedTitle.length > 256) {
    throw new Error("Issue title must contain 1 to 256 characters.");
  }
  return trimmedTitle;
}

function validateBody(body: string, label: string): string {
  if (body.trim().length === 0 || body.length > 65_536) {
    throw new Error(`${label} must contain 1 to 65536 characters.`);
  }
  return body;
}

function productionRunner(args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["api", ...args], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || error.message)
          .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+)\b/g, "[redacted]")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500);
        reject(new Error(detail ? `GitHub request failed: ${detail}` : "GitHub request failed."));
        return;
      }

      resolve(String(stdout));
    });
  });
}

export function createGithubApi(run: GithubApiRunner = productionRunner): GithubApi {
  const request = async <T>(args: string[]): Promise<T> => {
    const output = await run(["--hostname", "github.com", ...args]);
    return parseJson<T>(output);
  };

  const paginated = async <T>(path: string): Promise<T[]> => {
    const value = await request<unknown>(["--paginate", "--slurp", path]);
    return flattenPages<T>(value);
  };

  const readLabels = async (repository: GithubRepository): Promise<GitHubLabel[]> => {
    const values = await paginated<unknown>(`${repositoryPath(repository)}/labels?per_page=100`);
    return z.array(githubLabelSchema).parse(values);
  };

  const readIssue = async (repository: GithubRepository, issueNumber: number): Promise<GitHubIssue> => {
    const result = await request<unknown>([
      `${repositoryPath(repository)}/issues/${issueNumberPath(issueNumber)}`,
    ]);
    const issue = githubIssueSchema.parse(result);
    if (issue.pull_request) throw new Error("Pull requests are not supported by Git Kanban.");
    return addStageInfo(issue);
  };

  const requireStageLabel = async (repository: GithubRepository, name: string): Promise<void> => {
    validateStageLabel(name);
    const labels = await readLabels(repository);
    if (!labels.some((label) => label.name === name)) {
      throw new Error("Stage label is not configured on this repository.");
    }
  };

  return {
    listLabels: readLabels,

    async listIssues(repository) {
      const values = await paginated<unknown>(`${repositoryPath(repository)}/issues?state=all&per_page=100`);
      const issues = z.array(githubIssueSchema).parse(values);
      return issues.filter((issue) => !issue.pull_request).map(addStageInfo);
    },

    getIssue: readIssue,

    async listComments(repository, issueNumber) {
      const values = await paginated<unknown>(`${repositoryPath(repository)}/issues/${issueNumberPath(issueNumber)}/comments?per_page=100`);
      return z.array(githubCommentSchema).parse(values);
    },

    async createIssue(repository, input) {
      const title = validateIssueTitle(input.title);
      if (input.body.length > 65_536) throw new Error("Issue description must be at most 65536 characters.");
      if (input.stageLabel) await requireStageLabel(repository, input.stageLabel);
      if (input.priorityLabel) {
        if (!["priority:high", "priority:medium", "priority:low"].includes(input.priorityLabel)) {
          throw new Error("Priority label is invalid.");
        }
        const labels = await readLabels(repository);
        if (!labels.some((label) => label.name === input.priorityLabel)) {
          throw new Error("Priority label is not configured on this repository.");
        }
      }

      const args = ["--method", "POST", `${repositoryPath(repository)}/issues`, "--raw-field", `title=${title}`];
      if (input.body.length > 0) args.push("--raw-field", `body=${input.body}`);
      if (input.stageLabel) args.push("--raw-field", `labels[]=${input.stageLabel}`);
      if (input.priorityLabel) args.push("--raw-field", `labels[]=${input.priorityLabel}`);

      const result = await request<unknown>(args);
      return addStageInfo(issueCreateResultSchema.parse(result));
    },

    async addComment(repository, issueNumber, body) {
      validateBody(body, "Comment");
      const result = await request<unknown>([
        "--method", "POST",
        `${repositoryPath(repository)}/issues/${issueNumberPath(issueNumber)}/comments`,
        "--raw-field", `body=${body}`,
      ]);
      return githubCommentSchema.parse(result);
    },

    async moveIssueStage(repository, issueNumber, targetStageLabel) {
      const issue = await readIssue(repository, issueNumber);
      if (targetStageLabel !== null) await requireStageLabel(repository, targetStageLabel);

      const labels = [
        ...issue.labels.filter(({ name }) => !name.startsWith("stage:")).map(({ name }) => name),
        ...(targetStageLabel ? [targetStageLabel] : []),
      ];
      const currentLabels = issue.labels.map(({ name }) => name);
      if (labels.length === currentLabels.length && labels.every((name) => currentLabels.includes(name))) return issue;

      const path = `${repositoryPath(repository)}/issues/${issueNumberPath(issueNumber)}/labels`;
      if (labels.length === 0) {
        await request<unknown>(["--method", "DELETE", path]);
      } else {
        const args = ["--method", "PUT", path];
        for (const label of labels) args.push("--raw-field", `labels[]=${label}`);
        await request<unknown>(args);
      }

      return readIssue(repository, issueNumber);
    },
  };
}
