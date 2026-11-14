import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, FormEvent } from "react";
import { definePluginApp, useBbNavigate, useRpc, useSdk, experimental_useSidebarThreads } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { GitHubComment, GitHubIssue, GitHubLabel, StageLabel } from "./lib/github-api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";

type Repository = { owner: string; name: string; html_url: string };
type BoardData = { repository: Repository; stages: StageLabel[]; issues: GitHubIssue[] };
type BoardColumn = { id: string; title: string; stageLabel: string | null; color: string | null; kind: "stage" | "unstaged" | "conflict" };
const lastProjectStorageKey = "git-kanban:last-project";

function readLastProjectId(): string {
  try {
    return localStorage.getItem(lastProjectStorageKey) ?? "";
  } catch {
    return "";
  }
}

function safeLabelColor(color: string): string | undefined {
  return /^[0-9a-f]{6}$/i.test(color) ? `#${color}` : undefined;
}

function dateLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short" }).format(date);
}

function KanbanPage() {
  const rpc = useRpc<typeof rpcContract>();
  const sdk = useSdk();
  const navigate = useBbNavigate();
  const { projects, threads } = experimental_useSidebarThreads();
  const [projectId, setProjectId] = useState(readLastProjectId);
  const [linkedThreadId, setLinkedThreadId] = useState<string | null>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [selectedIssue, setSelectedIssue] = useState<GitHubIssue | null>(null);
  const [comments, setComments] = useState<GitHubComment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [commentsError, setCommentsError] = useState("");
  const [issueTitle, setIssueTitle] = useState("");
  const [issueBody, setIssueBody] = useState("");
  const [issueStageLabel, setIssueStageLabel] = useState("");
  const [commentBody, setCommentBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [pending, setPending] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const refreshInFlight = useRef(false);

  useEffect(() => {
    try {
      if (projectId) localStorage.setItem(lastProjectStorageKey, projectId);
      else localStorage.removeItem(lastProjectStorageKey);
    } catch {
      // Project selection still works for this session when browser storage is unavailable.
    }
  }, [projectId]);

  useEffect(() => {
    if (!projectId || projects.length === 0) return;
    if (projects.some((project) => project.id === projectId && !project.isPersonal)) return;
    setProjectId("");
  }, [projectId, projects]);

  const load = useCallback(async () => {
    if (!projectId) {
      setBoard(null);
      return null;
    }
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const result = await rpc.call("issues_list", { projectId });
      setBoard(result);
      return result;
    } catch (cause) {
      setBoard(null);
      setError(cause instanceof Error ? cause.message : "Не удалось загрузить GitHub Issues.");
      return null;
    } finally {
      setLoading(false);
    }
  }, [projectId, rpc]);

  useEffect(() => {
    if (!projectId || loading || pending) return;
    let active = true;
    const refresh = async () => {
      if (!active || document.visibilityState !== "visible" || refreshInFlight.current) return;
      refreshInFlight.current = true;
      try {
        const result = await rpc.call("issues_list", { projectId });
        if (active) {
          setBoard(result);
          setError("");
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : "Не удалось обновить Issues из GitHub.");
      } finally {
        refreshInFlight.current = false;
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    const interval = window.setInterval(() => void refresh(), 30_000);
    window.addEventListener("focus", refreshWhenVisible);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      active = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshWhenVisible);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [projectId, rpc, loading, pending]);

  useEffect(() => {
    let active = true;
    if (!projectId) {
      setBoard(null);
      setError("");
      return () => { active = false; };
    }
    setLoading(true);
    setBoard(null);
    setError("");
    setNotice("");
    rpc.call("issues_list", { projectId }).then((result) => {
      if (active) setBoard(result);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Не удалось загрузить GitHub Issues.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [projectId, rpc]);

  useEffect(() => {
    let active = true;
    if (!selectedIssue || !projectId) {
      setComments([]);
      setCommentsError("");
      setCommentsLoading(false);
      return () => { active = false; };
    }
    setComments([]);
    setCommentsError("");
    setCommentsLoading(true);
    rpc.call("issue_comments", { projectId, issueNumber: selectedIssue.number }).then(({ comments: loaded }) => {
      if (active) setComments(loaded);
    }).catch((cause: unknown) => {
      if (active) setCommentsError(cause instanceof Error ? cause.message : "Не удалось загрузить комментарии.");
    }).finally(() => {
      if (active) setCommentsLoading(false);
    });
    return () => { active = false; };
  }, [projectId, rpc, selectedIssue?.number]);

  useEffect(() => {
    let active = true;
    if (!projectId || !selectedIssue) {
      setLinkedThreadId(null);
      return () => { active = false; };
    }
    setLinkedThreadId(null);
    rpc.call("issue_thread_link_get", { projectId, issueNumber: selectedIssue.number }).then(({ threadId }) => {
      if (active) setLinkedThreadId(threadId);
    }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : "Не удалось загрузить связь с тредом.");
    });
    return () => { active = false; };
  }, [projectId, rpc, selectedIssue?.number]);

  const columns = useMemo<BoardColumn[]>(() => {
    if (!board) return [];
    const hasConflicts = board.issues.some((issue) => issue.stageState === "conflict");
    return [
      { id: "unstaged", title: "Без стадии", stageLabel: null, color: null, kind: "unstaged" },
      ...board.stages.map((stage) => ({ id: stage.name, title: stage.title, stageLabel: stage.name, color: stage.color, kind: "stage" as const })),
      ...(hasConflicts ? [{ id: "conflict", title: "Проверить метки", stageLabel: null, color: null, kind: "conflict" as const }] : []),
    ];
  }, [board]);

  const updateStage = async (issue: GitHubIssue, stageLabel: string | null) => {
    if (!projectId || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const updated = await rpc.call("issue_stage_set", { projectId, issueNumber: issue.number, stageLabel });
      const next = await load();
      setSelectedIssue(next?.issues.find((item) => item.number === updated.number) ?? updated);
      setNotice(`Стадия Issue #${issue.number} обновлена в GitHub.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось изменить стадию.");
    } finally {
      setPending(false);
    }
  };

  const dropIssue = (event: DragEvent<HTMLElement>, column: BoardColumn) => {
    event.preventDefault();
    if (column.kind === "conflict") return;
    const issueNumber = Number(event.dataTransfer.getData("text/github-issue"));
    const issue = board?.issues.find((item) => item.number === issueNumber);
    if (issue && (issue.stageLabels[0] ?? null) !== column.stageLabel) void updateStage(issue, column.stageLabel);
  };

  const createIssue = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectId || !issueTitle.trim() || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const created = await rpc.call("issue_create", {
        projectId,
        title: issueTitle.trim(),
        body: issueBody,
        stageLabel: issueStageLabel || null,
      });
      await load();
      setCreateOpen(false);
      setIssueTitle("");
      setIssueBody("");
      setIssueStageLabel("");
      setSelectedIssue(created);
      setNotice(`Issue #${created.number} создан в GitHub.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать Issue.");
    } finally {
      setPending(false);
    }
  };

  const addComment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projectId || !selectedIssue || !commentBody.trim() || pending) return;
    setPending(true);
    setError("");
    setNotice("");
    try {
      const comment = await rpc.call("issue_comment_add", { projectId, issueNumber: selectedIssue.number, body: commentBody.trim() });
      setComments((current) => [...current, comment]);
      setBoard((current) => current ? {
        ...current,
        issues: current.issues.map((issue) => issue.number === selectedIssue.number
          ? { ...issue, comments: issue.comments + 1 }
          : issue),
      } : current);
      setCommentBody("");
      setNotice("Комментарий опубликован в GitHub.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось добавить комментарий.");
    } finally {
      setPending(false);
    }
  };

  const issueForDialog = selectedIssue
    ? board?.issues.find((issue) => issue.number === selectedIssue.number) ?? selectedIssue
    : null;
  const projectThreads = threads.filter((thread) => thread.projectId === projectId && !thread.isHidden);
  const linkedThread = projectThreads.find((thread) => thread.id === linkedThreadId);

  const linkThread = async (issue: GitHubIssue, threadId: string | null) => {
    if (!projectId) return;
    setPending(true);
    setError("");
    try {
      await rpc.call("issue_thread_link_set", { projectId, issueNumber: issue.number, threadId });
      setLinkedThreadId(threadId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить связь с тредом.");
    } finally {
      setPending(false);
    }
  };

  const createThreadForIssue = async (issue: GitHubIssue) => {
    if (!projectId || pending) return;
    setPending(true);
    setError("");
    try {
      const thread = await sdk.threads.spawn({
        projectId,
        environment: { type: "project-default" },
        prompt: `Работа по GitHub Issue #${issue.number}: ${issue.title}${issue.body ? `\n\n${issue.body}` : ""}\n\nGitHub: ${issue.html_url}`,
        title: `#${issue.number} ${issue.title}`,
      });
      await rpc.call("issue_thread_link_set", { projectId, issueNumber: issue.number, threadId: thread.id });
      setLinkedThreadId(thread.id);
      navigate.toThread(thread.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось создать тред.");
    } finally {
      setPending(false);
    }
  };

  return <div className="h-full min-h-0 flex-1 overflow-auto bg-background text-foreground">
    <div className="mx-auto max-w-7xl p-5">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold">Git Kanban</h1>
          <p className="mt-1 text-sm text-muted-foreground">GitHub Issues выбранного проекта</p>
        </div>
        <label className="flex min-w-52 items-center gap-2 text-sm font-medium">
          <span>Проект</span>
          <select aria-label="Проект" className="select h-9 min-w-40 rounded-md border border-input bg-background px-3 text-sm text-foreground" value={projectId} onChange={(event) => { setProjectId(event.target.value); setSelectedIssue(null); }}>
            <option value="">Выберите проект</option>
            {projects.filter((project) => !project.isPersonal).map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
      </header>
      {projectId && <p className="-mt-3 mb-4 text-xs text-muted-foreground">Обновление каждые 30 секунд и при возвращении в окно</p>}

      {error && <div role="alert" className="alert alert-error mb-4 rounded-lg border border-error/20 bg-error/5 text-sm text-error">{error}</div>}
      {notice && <div role="status" className="alert alert-info mb-4 rounded-lg border border-info/20 bg-info/5 text-sm text-info">{notice}</div>}

      {projectId && <div className="mb-4 flex flex-wrap items-center gap-2">
        {board && <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{board.repository.owner}/{board.repository.name}</span>}
        <Button type="button" variant="outline" size="sm" className="btn btn-sm" disabled={loading} onClick={() => void load()}>{loading ? "Обновление…" : "Обновить"}</Button>
        {board && <Button type="button" size="sm" className="btn btn-sm" onClick={() => setCreateOpen(true)}>Новый Issue</Button>}
        {board && <Button type="button" size="sm" variant="ghost" className="btn btn-ghost btn-sm" onClick={() => void navigate.openUrl(`${board.repository.html_url}/labels`)}>Настроить стадии в GitHub</Button>}
      </div>}

      {!projectId && <div className="card card-border rounded-xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">Выберите BB-проект с GitHub remote.</div>}
      {projectId && loading && <div role="status" className="flex items-center gap-2 py-8 text-sm text-muted-foreground"><span className="loading loading-spinner loading-sm inline-block size-4 animate-spin rounded-full border-2 border-current border-r-transparent"/>Загружаю Issues из GitHub…</div>}
      {projectId && !loading && board && board.stages.length === 0 && <div className="alert alert-warning mb-4 rounded-lg border border-warning/20 bg-warning/5 text-sm text-warning">В репозитории нет stage-labels. Добавьте labels вида <code>stage:10:Backlog</code> на GitHub.</div>}

      {projectId && !loading && board && <>
        {board.issues.length === 0 && <div className="card card-border mb-4 rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">В репозитории нет Issues.</div>}
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {columns.map((column) => {
            const columnColor = safeLabelColor(column.color ?? "");
            const issues = board.issues.filter((issue) => {
              if (column.kind === "unstaged") return issue.stageState === "unstaged";
              if (column.kind === "conflict") return issue.stageState === "conflict";
              return issue.stageState === "stage" && issue.stageLabels[0] === column.stageLabel;
            });
            return <section key={column.id} aria-label={column.title} className="min-h-60 rounded-xl border border-border/70 bg-muted/30 p-3" style={columnColor ? { backgroundColor: `${columnColor}1a` } : undefined} onDragOver={(event) => { if (column.kind !== "conflict") event.preventDefault(); }} onDrop={(event) => dropIssue(event, column)}>
              <h2 className="mb-3 flex items-center justify-between gap-2 rounded-md px-2 py-1 text-sm font-semibold" style={columnColor ? { backgroundColor: `${columnColor}30`, borderLeft: `3px solid ${columnColor}` } : undefined}>
                <span className="truncate">{column.title}</span>
              <span className="badge badge-ghost badge-sm inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-muted-foreground">{issues.length}</span>
              </h2>
              <div className="space-y-2">
                {issues.map((issue) => <article key={issue.number} draggable onDragStart={(event) => { event.dataTransfer.setData("text/github-issue", String(issue.number)); event.dataTransfer.effectAllowed = "move"; }} className={`card card-border group flex cursor-grab flex-col rounded-xl border border-border bg-card shadow-sm transition-shadow hover:shadow-md active:cursor-grabbing ${issue.state === "closed" ? "opacity-80" : ""}`} style={columnColor ? { borderTop: `3px solid ${columnColor}` } : undefined}>
                  <div className="card-body flex flex-col gap-2 p-3.5">
                    <div className="flex items-start justify-between gap-2"><button type="button" className="block min-w-0 flex-1 break-words text-left text-sm font-semibold leading-snug hover:underline" onClick={() => setSelectedIssue(issue)} aria-haspopup="dialog">#{issue.number} {issue.title}</button>{issue.state === "closed" && <span className="badge badge-warning badge-sm inline-flex shrink-0 items-center rounded-full border border-warning/20 bg-warning/5 px-2 py-0.5 text-[11px] text-warning">Закрыт</span>}</div>
                    {issue.body && <p className="line-clamp-3 whitespace-pre-wrap text-xs leading-relaxed text-muted-foreground" style={{ overflowWrap: "anywhere" }}>{issue.body}</p>}
                    <div className="flex flex-wrap gap-1.5" aria-label="Labels Issue">
                      {issue.labels.filter((label) => !label.name.startsWith("stage:")).map((label: GitHubLabel) => <span key={label.name} className="badge badge-outline badge-sm inline-flex max-w-full items-center truncate rounded-full border px-2 py-0.5 text-[11px] text-muted-foreground" style={{ borderColor: safeLabelColor(label.color) }}>{label.name}</span>)}
                    </div>
                    <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted-foreground">
                      <span className="truncate">{issue.user?.login ? `@${issue.user.login}` : "Автор неизвестен"} · {dateLabel(issue.updated_at)}</span>
                      <span className="badge badge-ghost badge-sm shrink-0" aria-label={`${issue.comments} комментариев`}>{issue.comments} комм.</span>
                    </div>
                  </div>
                </article>)}
              </div>
            </section>;
          })}
        </div>
      </>}
    </div>

    <Dialog open={issueForDialog !== null} onOpenChange={(open) => { if (!open) { setSelectedIssue(null); setCommentBody(""); } }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {issueForDialog && <>
          <DialogHeader>
            <DialogTitle>#{issueForDialog.number} {issueForDialog.title}</DialogTitle>
            <DialogDescription>Issue из {board?.repository.owner}/{board?.repository.name}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" size="sm" variant="outline" className="btn btn-outline btn-sm" onClick={() => void navigate.openUrl(issueForDialog.html_url)}>Открыть на GitHub</Button>
            <label className="flex min-w-48 flex-1 items-center gap-2 text-sm font-medium">
              <span>Стадия</span>
              <select aria-label={`Стадия Issue ${issueForDialog.number}`} className="select h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground" disabled={pending} value={issueForDialog.stageLabels.length === 1 ? issueForDialog.stageLabels[0] : ""} onChange={(event) => void updateStage(issueForDialog, event.target.value || null)}>
                <option value="">Без стадии</option>
                {board?.stages.map((stage) => <option key={stage.name} value={stage.name}>{stage.title}</option>)}
              </select>
            </label>
          </div>
          <section className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
            <h3 className="text-sm font-semibold">BB-тред</h3>
            {linkedThreadId ? <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">{linkedThread?.displayTitle ?? linkedThreadId}</span>
              <Button type="button" size="sm" className="btn btn-sm" onClick={() => navigate.toThread(linkedThreadId)}>Открыть тред</Button>
              <Button type="button" size="sm" variant="outline" className="btn btn-outline btn-sm" disabled={pending} onClick={() => void linkThread(issueForDialog, null)}>Отвязать</Button>
            </div> : <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" variant="outline" className="btn btn-outline btn-sm" disabled={pending} onClick={() => void createThreadForIssue(issueForDialog)}>Создать новый тред</Button>
              {projectThreads.length > 0 && <select aria-label={`Привязать BB-тред к Issue ${issueForDialog.number}`} className="select h-9 min-w-48 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground" defaultValue="" onChange={(event) => { if (event.target.value) linkThread(issueForDialog, event.target.value); }}>
                <option value="">Выбрать существующий тред…</option>
                {projectThreads.map((thread) => <option key={thread.id} value={thread.id}>{thread.displayTitle}</option>)}
              </select>}
              {projectThreads.length === 0 && <span className="text-xs text-muted-foreground">В проекте пока нет тредов.</span>}
            </div>}
            <p className="text-xs text-muted-foreground">Связь хранится только в этом браузере и не отправляется в GitHub.</p>
          </section>
          {issueForDialog.body && <p className="whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm leading-relaxed" style={{ overflowWrap: "anywhere" }}>{issueForDialog.body}</p>}
          {issueForDialog.stageState === "conflict" && <div role="alert" className="alert alert-warning rounded-lg border border-warning/20 bg-warning/5 text-sm text-warning">У Issue несколько stage-label. Выберите одну стадию, чтобы исправить конфликт.</div>}
          <section className="border-t border-border pt-4">
            <h3 className="mb-3 text-sm font-semibold">Комментарии ({comments.length})</h3>
            {commentsError && <p role="alert" className="mb-3 text-sm text-error">{commentsError}</p>}
            {commentsLoading && <p role="status" className="text-sm text-muted-foreground">Загружаю комментарии…</p>}
            <div className="space-y-3">
              {comments.map((comment) => <article key={comment.id} className="card card-border rounded-lg border border-border bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground"><span className="truncate">{comment.user?.login ? `@${comment.user.login}` : "GitHub"}</span><time>{dateLabel(comment.created_at)}</time></div>
                <p className="whitespace-pre-wrap text-sm" style={{ overflowWrap: "anywhere" }}>{comment.body}</p>
              </article>)}
              {!commentsLoading && comments.length === 0 && !commentsError && <p className="text-sm text-muted-foreground">Комментариев пока нет.</p>}
            </div>
            <form onSubmit={addComment} className="mt-4 space-y-2">
              <label className="block text-sm font-medium" htmlFor="github-issue-comment">Новый комментарий</label>
              <textarea id="github-issue-comment" required maxLength={65_536} rows={3} value={commentBody} onChange={(event) => setCommentBody(event.target.value)} className="textarea min-h-24 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground" placeholder="Написать комментарий…"/>
              <Button type="submit" className="btn" disabled={pending || !commentBody.trim()}>{pending ? "Отправка…" : "Добавить комментарий"}</Button>
            </form>
          </section>
        </>}
      </DialogContent>
    </Dialog>

    <Dialog open={createOpen} onOpenChange={setCreateOpen}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Новый GitHub Issue</DialogTitle><DialogDescription>Issue сразу создаётся в выбранном GitHub-репозитории.</DialogDescription></DialogHeader>
        <form onSubmit={createIssue} className="space-y-4">
          <label className="block space-y-1 text-sm font-medium">Заголовок<Input required maxLength={256} value={issueTitle} onChange={(event) => setIssueTitle(event.target.value)} autoFocus/></label>
          <label className="block space-y-1 text-sm font-medium">Описание<textarea maxLength={65_536} rows={6} value={issueBody} onChange={(event) => setIssueBody(event.target.value)} className="textarea min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"/></label>
          <label className="block space-y-1 text-sm font-medium">Стадия<select className="select h-9 w-full rounded-md border border-input bg-background px-3 text-sm text-foreground" value={issueStageLabel} onChange={(event) => setIssueStageLabel(event.target.value)}><option value="">Без стадии</option>{board?.stages.map((stage) => <option key={stage.name} value={stage.name}>{stage.title}</option>)}</select></label>
          <div className="flex flex-wrap justify-end gap-2"><Button type="button" variant="outline" className="btn btn-outline" disabled={pending} onClick={() => setCreateOpen(false)}>Отмена</Button><Button type="submit" className="btn" disabled={pending || !issueTitle.trim()}>{pending ? "Создание…" : "Создать Issue"}</Button></div>
        </form>
      </DialogContent>
    </Dialog>
  </div>;
}

export default definePluginApp((app) => {
  app.slots.navPanel({ id: "git-kanban", title: "Git Kanban", icon: "Columns3", path: "board", component: KanbanPage });
});
