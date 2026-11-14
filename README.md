# Git Kanban

Git Kanban is a BB plugin that turns GitHub Issues into a Kanban board. It connects a BB project to its GitHub.com repository and lets you manage Issues without leaving BB.

## Features

- View open and closed GitHub Issues in stage columns.
- Create Issues, add comments, and move Issues between stages from the board.
- Use repository labels named `stage:<number>:<name>` to define stages. The number sets the column order, and the label color sets the column color.
- See Issues with no stage or conflicting stage labels in separate columns so they can be corrected.
- Refresh the board every 30 seconds and when the BB window becomes active.
- Keep Issues, comments, labels, and stage order in GitHub. The plugin stores only the last selected BB project ID in browser `localStorage`.

## Requirements

- BB `>=0.49` and BB Plugin SDK `>=0.6.132`.
- A BB project connected to a GitHub.com repository.
- GitHub CLI (`gh`) installed and authenticated with permission to read and update Issues in that repository.

The plugin uses the user's existing `gh` authentication. It does not ask for or store a separate GitHub token.

## Issue stages

Create labels in the repository using this format:

```text
stage:<number>:<name>
```

For example, `stage:10:Backlog`, `stage:20:In Progress`, and `stage:50:Done` appear in that order. Label colors style the corresponding columns and cards. Other labels remain ordinary Issue labels.

Repository GitHub Actions can close Issues moved to `Done` or `Canceled` and reopen Issues moved to any other stage. The plugin updates stage labels; Actions synchronize the Issue's open or closed state.

## Install from source

Run these commands from the repository directory:

```sh
npm install
bb plugin build .
bb plugin install .
```

After changing source files, rebuild and reload the plugin:

```sh
bb plugin build .
bb plugin reload git-kanban
```

## Project files

- `app.tsx` implements the Kanban board UI.
- `server.ts` defines BB RPC handlers and resolves a BB project to its GitHub repository.
- `lib/github-api.ts` calls GitHub through `gh`.
- `tests/` contains server and GitHub API tests.
