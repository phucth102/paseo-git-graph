# Paseo Git Graph

A [Paseo](https://paseo.sh) workspace panel that draws your commit graph, in the spirit of
[vscode-git-graph](https://github.com/mhutchie/vscode-git-graph). It knows about submodules, so a
meta-repo shows the superproject and every initialised submodule from one repository picker.

Built against **Paseo 0.5.1**. The plugin API is still experimental, so a newer Paseo may require
an update here.

## Install

No build step and no `npm install` — the daemon compiles the source itself, and the React and SDK
modules come from the app at runtime.

```bash
git clone https://github.com/phucth102/paseo-git-graph.git
paseo plugin install ~/paseo-git-graph
```

Plugins have to be enabled once per daemon, in **Settings → Plugins → Enable plugins**.

Open a workspace, then either press ⌘K and choose **Open Git Graph**, or pick **Git Graph** from
the `+` menu in the tab bar.

## What you get

- Commit graph with lanes and colours, branch/tag/stash labels, and an **Uncommitted Changes** row
  parented to HEAD.
- Repository picker over the workspace repo and its submodules, a branch filter, a
  **Show Remote Branches** toggle, search that steps through hits, and **Fetch**.
- Click a commit to expand it in place: full message, commit/parents/author/committer/date, and the
  changed files as a folder tree with per-file line counts. Parent hashes are links.
- Click a file for its diff, unified or side by side.
- Right-click a commit for checkout, create branch, create tag, cherry pick, revert, merge, reset,
  and the two clipboard entries.
- Double-click a branch label to check it out; a remote label asks what to name the local branch
  first. Right-click a label for rename, delete, merge, pull, fetch into a local branch, push, and
  delete on the remote.
- The selected repository, branch and remote toggle are remembered per workspace in
  `$PASEO_HOME/plugin-git-graph.json`.

## Trust and safety

**A Paseo plugin is trusted, unsandboxed code**: its backend runs as a subprocess of your daemon
with your permissions. Read the source before installing this, or any other plugin.

This one shells out to `git` only — never through a shell, always `execFile` with an argument list.
It reads with `log`, `show`, `status`, `diff`, `for-each-ref`, `rev-parse`, `rev-list`, `tag`,
`remote` and `config`.

It **writes** when you pick one of the actions: `checkout`, `branch`, `tag`, `cherry-pick`,
`revert`, `merge`, `reset`, `fetch`, `pull`, `push`. Every one of those opens a dialog first, and
each says what it does — `reset --hard` says plainly that it discards uncommitted work, and push
and delete-on-remote name the remote they will touch. Nothing runs on a single stray click.

Paths from the panel are only accepted when they are the workspace repository or one of its
submodules, and branch or tag names go through `git check-ref-format` before they reach git.

## Notes for meta-repos

`.gitmodules` files often set `ignore = all`, which hides submodule pointer moves from `git diff`
and `git show`. A commit that only bumps submodules then looks empty. Diffs here pass
`--ignore-submodules=none`, so those pointer moves are visible.

The graph walks branches, remotes, tags, the stash and HEAD rather than `--all`, so checkpoint refs
parked by other tools (`refs/conductor-checkpoints/*` and friends) stay out of your history. Change
`LOG_REFS` in `git.server.ts` if you want everything.

## Development

```bash
npm install        # only needed for the typecheck
npm run typecheck
paseo plugin reload git-graph
paseo plugin logs git-graph
```

Source edits need an explicit `paseo plugin reload`; restarting the daemon is not the way to pick
them up, and it would kill running agents.

To see the panel in a browser without touching the daemon you work in, run a throwaway one with the
bundled web UI:

```bash
paseo daemon start --home /tmp/gg-daemon --listen 127.0.0.1:6801 --web-ui --no-relay
paseo plugin install "$PWD" --host 127.0.0.1:6801
paseo project create /path/to/repo --host 127.0.0.1:6801
paseo workspace create --isolation local --path /path/to/repo --project <id> --host 127.0.0.1:6801
```

Then open `http://127.0.0.1:6801/`. Check the port is free first: an in-use port makes the daemon
exit with EADDRINUSE while `--host` quietly talks to whatever is already listening. Point write
actions at a scratch repository, never at real work.

## Layout

| File | Role |
| --- | --- |
| `index.ts` | Registers the twelve RPCs, the workspace panel, and the Command Center item. |
| `graph.shared.ts` | Zod contracts shared by both bundles. |
| `git.server.ts` | Daemon side: runs git, parses output, guards paths and names. |
| `layout.client.ts` | Lane assignment. Pure functions, no React. |
| `graph-row.client.tsx` | One commit row: graph cell, ref labels, metadata columns. |
| `panel.client.tsx` | Panel shell: pickers, search, list, working-tree row. |
| `detail.client.tsx` | Expanded row: message, metadata, file tree, diff view. |
| `actions.client.tsx` | Context menus, action dialogs, clipboard helper. |
| `colors.client.ts` | Branch palette, picked from the luminance of the panel background. |

Two constraints shape the client code:

- Plugin client bundles may only import `react`, `react-native`, `@tanstack/react-query`, `zod`,
  `@getpaseo/plugin` and `@getpaseo/plugin/server`. There is no SVG or canvas, so graph edges are
  views: straight runs are thin rectangles, lane changes are boxes with two adjacent borders and a
  rounded corner.
- Plugin RPC is request/response with no push channel, so the panel polls a cheap ref-hash
  signature every few seconds and refetches only when it changes.

## Not implemented yet

Expanding a submodule pointer bump into the commits it contains, rebase, stash actions, staging or
committing from the working-tree row, and word-level highlighting inside a diff.

## License

MIT. See [LICENSE](LICENSE).
