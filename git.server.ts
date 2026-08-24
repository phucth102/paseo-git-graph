import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { output as ZodOutput } from "zod";
import { WORKING_TREE_ID } from "./graph.shared";
import type { ChangedFile, Commit, Ref, Repo } from "./graph.shared";
import type {
  Preferences,
  branchesRpc,
  actionRpc,
  fetchRpc,
  fileDiffRpc,
  readPrefsRpc,
  refActionRpc,
  writePrefsRpc,
  commitDetailRpc,
  logRpc,
  reposRpc,
  signatureRpc,
  workingTreeRpc,
} from "./graph.shared";

const execFileAsync = promisify(execFile);

const RECORD_SEPARATOR = "\x1e";
const FIELD_SEPARATOR = "\x00";
/**
 * Which refs the graph walks. Deliberately not `--all`: tools such as Conductor and Paseo park
 * hundreds of checkpoint commits under their own namespaces, and none of them are history a
 * person wants to read.
 */
// `--glob=refs/stash` would be read as `refs/stash/*` and quietly miss the stash itself.
const BASE_LOG_REFS = ["--branches", "--tags", "--glob=refs/stash*", "HEAD"];
const LOG_FORMAT = "--pretty=format:%x1e%H%x00%P%x00%an%x00%at%x00%D%x00%s";
const DETAIL_FORMAT = "--format=%B%x00%ae%x00%cn%x00%ce";
const HASH_PATTERN = /^[0-9a-f]{7,40}$/;
const MAX_BUFFER = 32 * 1024 * 1024;
const MAX_DETAIL_FILES = 400;
const MAX_DIFF_LINES = 1200;
const FETCH_TIMEOUT_MS = 45_000;
/**
 * This workspace's `.gitmodules` sets `ignore = all`, which hides every submodule pointer move
 * from diff output — a commit that only bumps submodules would look empty. In a meta-repo those
 * pointer moves are the history, so diffs ask for them explicitly. `git status` keeps the repo's
 * own setting, so the uncommitted count matches what the terminal reports.
 */
const SHOW_SUBMODULES = "--ignore-submodules=none";

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
  return stdout;
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

/**
 * `git diff --no-index` reports "files differ" with exit code 1, which rejects the promise even
 * though the patch is sitting in stdout. Anything git writes before failing is still usable.
 */
async function gitKeepingOutput(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch (error) {
    const stdout = (error as { stdout?: unknown }).stdout;
    return typeof stdout === "string" && stdout.length > 0 ? stdout : null;
  }
}

function realPath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/** Absolute path of the repository that owns `directory`, or null when it is not a work tree. */
async function toplevelOf(directory: string): Promise<string | null> {
  const stdout = await gitOrNull(directory, ["rev-parse", "--show-toplevel"]);
  return stdout ? path.resolve(stdout.trim()) : null;
}

export async function listRepos({
  root,
}: ZodOutput<typeof reposRpc.input>): Promise<{ repos: Repo[] }> {
  const toplevel = await toplevelOf(root);
  if (!toplevel) return { repos: [] };

  const repos: Repo[] = [{ path: toplevel, name: path.basename(toplevel), isSubmodule: false }];

  const gitmodules = path.join(toplevel, ".gitmodules");
  if (!existsSync(gitmodules)) return { repos };

  const stdout = await gitOrNull(toplevel, [
    "config",
    "-f",
    ".gitmodules",
    "--get-regexp",
    "^submodule\\..*\\.path$",
  ]);
  if (!stdout) return { repos };

  const relativePaths = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(" ") + 1).trim())
    .filter(Boolean);

  for (const relativePath of [...new Set(relativePaths)].sort()) {
    const absolute = path.resolve(toplevel, relativePath);
    // An uninitialised submodule is an empty directory with no .git entry.
    if (!existsSync(path.join(absolute, ".git"))) continue;
    repos.push({ path: absolute, name: relativePath, isSubmodule: true });
  }

  return { repos };
}

/** Client-supplied paths are only trusted when they are the workspace repo or one of its submodules. */
async function assertAllowed(root: string, repoPath: string): Promise<string> {
  // git reports real paths, so a symlinked directory (/tmp on macOS, symlinked homes) has to be
  // resolved the same way before the comparison, or every call is rejected.
  const resolved = realPath(path.resolve(repoPath));
  const { repos } = await listRepos({ root });
  if (!repos.some((repo) => repo.path === resolved)) {
    throw new Error(`Repository is not part of this workspace: ${repoPath}`);
  }
  return resolved;
}

function parseRefs(raw: string, remotes: string[]): Ref[] {
  if (!raw.trim()) return [];
  const refs: Ref[] = [];
  for (const entry of raw.split(", ")) {
    const value = entry.trim();
    if (!value) continue;
    if (value.startsWith("tag: ")) {
      refs.push({ name: value.slice("tag: ".length), type: "tag" });
      continue;
    }
    if (value.startsWith("HEAD -> ")) {
      refs.push({ name: value.slice("HEAD -> ".length), type: "head" });
      continue;
    }
    if (value === "HEAD") {
      refs.push({ name: "HEAD", type: "head" });
      continue;
    }
    if (value.startsWith("refs/stash")) {
      refs.push({ name: "stash", type: "stash" });
      continue;
    }
    const isRemote = remotes.some((remote) => value.startsWith(`${remote}/`));
    refs.push({ name: value, type: isRemote ? "remote" : "branch" });
  }
  // HEAD first, then local branches, then tags, then remotes.
  const rank: Record<Ref["type"], number> = { head: 0, branch: 1, tag: 2, remote: 3, stash: 4 };
  return refs.sort((a, b) => rank[a.type] - rank[b.type]);
}

export async function listBranches(input: ZodOutput<typeof branchesRpc.input>): Promise<{
  branches: string[];
  remoteBranches: string[];
  remotes: string[];
  head: string | null;
}> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  // The full refname is the only reliable way to tell `refs/heads/feat/x` from `refs/remotes/o/x`;
  // the short name alone contains a slash in both cases.
  const stdout =
    (await gitOrNull(repoPath, [
      "for-each-ref",
      // Refnames cannot contain spaces, and a literal NUL cannot travel in argv.
      "--format=%(refname) %(refname:short)",
      "refs/heads",
      "refs/remotes",
    ])) ?? "";
  const branches: string[] = [];
  const remoteBranches: string[] = [];
  for (const line of stdout.split("\n")) {
    const [refname, short] = line.trim().split(" ");
    if (!refname || !short) continue;
    if (short.endsWith("/HEAD")) continue;
    if (refname.startsWith("refs/heads/")) branches.push(short);
    else if (refname.startsWith("refs/remotes/")) remoteBranches.push(short);
  }
  const abbrev = (await gitOrNull(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? null;
  const remotes = ((await gitOrNull(repoPath, ["remote"])) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return {
    branches: branches.sort(),
    remoteBranches: remoteBranches.sort(),
    remotes,
    head: abbrev && abbrev !== "HEAD" ? abbrev : null,
  };
}

/**
 * Refs the walk starts from. A branch name coming from the client is only used after it turns up
 * in `for-each-ref`, so it can never reach git as an option like `--upload-pack=`.
 */
async function logRefs(
  repoPath: string,
  root: string,
  branch: string | null,
  showRemotes: boolean,
): Promise<string[]> {
  if (!branch) {
    return showRemotes ? [...BASE_LOG_REFS, "--remotes"] : [...BASE_LOG_REFS];
  }
  const { branches, remoteBranches } = await listBranches({ root, repoPath });
  if (branches.includes(branch)) {
    const tracking = remoteBranches.filter((name) => name.slice(name.indexOf("/") + 1) === branch);
    return showRemotes ? [branch, ...tracking] : [branch];
  }
  if (remoteBranches.includes(branch)) return [branch];
  throw new Error(`Unknown branch: ${branch}`);
}

export async function readLog(input: ZodOutput<typeof logRpc.input>): Promise<{
  commits: Commit[];
  headHash: string | null;
  headLabel: string | null;
  moreAvailable: boolean;
  uncommittedCount: number;
}> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  const remotesRaw = (await gitOrNull(repoPath, ["remote"])) ?? "";
  const remotes = remotesRaw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const refs = await logRefs(repoPath, input.root, input.branch, input.showRemotes);
  const stdout =
    (await gitOrNull(repoPath, [
      "log",
      "--date-order",
      `--max-count=${input.limit + 1}`,
      LOG_FORMAT,
      ...refs,
    ])) ?? "";

  const commits: Commit[] = [];
  for (const record of stdout.split(RECORD_SEPARATOR)) {
    if (!record) continue;
    const [hash, parents, author, date, refs, subject] = record.split(FIELD_SEPARATOR);
    if (!hash) continue;
    commits.push({
      hash,
      parents: (parents ?? "").split(" ").filter(Boolean),
      author: author ?? "",
      date: Number.parseInt(date ?? "0", 10) || 0,
      subject: (subject ?? "").replace(/\n[\s\S]*$/, ""),
      refs: parseRefs(refs ?? "", remotes),
    });
  }

  const moreAvailable = commits.length > input.limit;
  if (moreAvailable) commits.length = input.limit;

  const headHash = (await gitOrNull(repoPath, ["rev-parse", "HEAD"]))?.trim() ?? null;
  const abbrev = (await gitOrNull(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]))?.trim() ?? null;
  const headLabel = !abbrev || abbrev === "HEAD" ? (headHash ? headHash.slice(0, 7) : null) : abbrev;
  const uncommittedCount = (await readStatusEntries(repoPath)).length;

  return { commits, headHash, headLabel, moreAvailable, uncommittedCount };
}

interface StatusEntry {
  status: string;
  path: string;
}

/**
 * `git status --porcelain -z` records are `XY <path>` terminated by NUL, and rename or copy
 * records carry a second NUL-terminated field with the old path.
 */
async function readStatusEntries(repoPath: string): Promise<StatusEntry[]> {
  const stdout =
    (await gitOrNull(repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])) ?? "";
  const fields = stdout.split(FIELD_SEPARATOR);
  const entries: StatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const record = fields[index];
    if (!record || record.length < 4) continue;
    entries.push({ status: record.slice(0, 2), path: record.slice(3) });
    if (record.startsWith("R") || record.startsWith("C")) index += 1;
  }
  return entries;
}

export async function readWorkingTree(
  input: ZodOutput<typeof workingTreeRpc.input>,
): Promise<{ files: ChangedFile[]; count: number; truncatedFiles: boolean }> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  const entries = await readStatusEntries(repoPath);

  // Line counts only exist for tracked changes; untracked files have no diff against HEAD.
  const numstat =
    (await gitOrNull(repoPath, ["diff", "--numstat", SHOW_SUBMODULES, "HEAD"])) ?? "";
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  for (const line of numstat.split("\n")) {
    const [additions, deletions, ...rest] = line.trim().split("\t");
    const filePath = rest.join("\t");
    if (!filePath) continue;
    counts.set(filePath, {
      additions: additions === "-" ? null : Number.parseInt(additions ?? "0", 10),
      deletions: deletions === "-" ? null : Number.parseInt(deletions ?? "0", 10),
    });
  }

  const files: ChangedFile[] = entries.map((entry) => ({
    path: entry.path,
    status: entry.status,
    additions: counts.get(entry.path)?.additions ?? null,
    deletions: counts.get(entry.path)?.deletions ?? null,
  }));
  const truncatedFiles = files.length > MAX_DETAIL_FILES;

  return {
    files: truncatedFiles ? files.slice(0, MAX_DETAIL_FILES) : files,
    count: files.length,
    truncatedFiles,
  };
}

export async function readCommitDetail(input: ZodOutput<typeof commitDetailRpc.input>) {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  if (!HASH_PATTERN.test(input.hash)) throw new Error(`Invalid commit hash: ${input.hash}`);

  const header = await git(repoPath, ["show", "--no-patch", DETAIL_FORMAT, input.hash]);
  const [body, authorEmail, committer, committerEmail] = header.split(FIELD_SEPARATOR);

  // `--raw` carries the status letter, `--numstat` the line counts. Asking for both in one call
  // keeps the two lists consistent even when a commit renames a file.
  const diff =
    (await gitOrNull(repoPath, [
      "show",
      "--raw",
      "--numstat",
      "--format=",
      "--first-parent",
      SHOW_SUBMODULES,
      input.hash,
    ])) ?? "";

  // `--raw` lists every changed path with its status letter; `--numstat` adds line counts but
  // omits binaries and pointer moves, so the raw list is the one that decides what is shown.
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();
  const files: ChangedFile[] = [];
  for (const line of diff.split("\n")) {
    if (!line.trim()) continue;
    const fields = line.split("\t");
    if (line.startsWith(":")) {
      // ":<mode> <mode> <sha> <sha> <status>\t<path>[\t<new path>]"
      const status = fields[0]?.split(" ").pop() ?? "M";
      const filePath = fields[fields.length - 1] ?? "";
      if (filePath) files.push({ path: filePath, status, additions: null, deletions: null });
      continue;
    }
    const [additions, deletions, ...rest] = fields;
    const filePath = rest.join("\t");
    if (!filePath) continue;
    counts.set(filePath, {
      additions: additions === "-" ? null : Number.parseInt(additions ?? "0", 10),
      deletions: deletions === "-" ? null : Number.parseInt(deletions ?? "0", 10),
    });
  }
  for (const file of files) {
    const count = counts.get(file.path);
    file.additions = count?.additions ?? null;
    file.deletions = count?.deletions ?? null;
  }

  const truncatedFiles = files.length > MAX_DETAIL_FILES;

  return {
    body: (body ?? "").trimEnd(),
    authorEmail: (authorEmail ?? "").trim(),
    committer: (committer ?? "").trim(),
    committerEmail: (committerEmail ?? "").trim(),
    files: truncatedFiles ? files.slice(0, MAX_DETAIL_FILES) : files,
    truncatedFiles,
  };
}

export async function readFileDiff(input: ZodOutput<typeof fileDiffRpc.input>): Promise<{
  lines: string[];
  truncated: boolean;
  note: string | null;
}> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  const isWorkingTree = input.hash === WORKING_TREE_ID;
  if (!isWorkingTree && !HASH_PATTERN.test(input.hash)) {
    throw new Error(`Invalid commit hash: ${input.hash}`);
  }

  // `--` keeps a path that starts with a dash from being read as an option.
  const args = isWorkingTree
    ? ["diff", SHOW_SUBMODULES, "HEAD", "--", input.path]
    : ["show", "--format=", "--first-parent", SHOW_SUBMODULES, input.hash, "--", input.path];
  let patch = (await gitOrNull(repoPath, args)) ?? "";

  if (!patch.trim() && isWorkingTree) {
    // Untracked files have nothing to diff against, so show them as added in full.
    patch =
      (await gitKeepingOutput(repoPath, ["diff", "--no-index", "--", "/dev/null", input.path])) ??
      "";
  }

  const all = patch.split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop();
  const truncated = all.length > MAX_DIFF_LINES;
  const lines = truncated ? all.slice(0, MAX_DIFF_LINES) : all;
  const note = lines.length === 0 ? "No textual diff for this path." : null;

  return { lines, truncated, note };
}

/** The Fetch button. Updates remote-tracking refs only; nothing in the working tree moves. */
export async function fetchRemotes(
  input: ZodOutput<typeof fetchRpc.input>,
): Promise<{ output: string }> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  const { stdout, stderr } = await execFileAsync("git", ["fetch", "--all", "--prune"], {
    cwd: repoPath,
    maxBuffer: MAX_BUFFER,
    timeout: FETCH_TIMEOUT_MS,
  });
  return { output: `${stdout}${stderr}`.trim() || "Already up to date." };
}

/**
 * A branch or tag name is handed straight to git, so it goes through git's own validator first.
 * `check-ref-format` rejects spaces, `..`, control characters, leading dashes and the rest.
 */
async function assertRefName(repoPath: string, kind: "branch" | "tag", name: string): Promise<string> {
  const candidate = name.trim();
  if (!candidate) throw new Error(`Enter a ${kind} name.`);
  const args =
    kind === "branch"
      ? ["check-ref-format", "--branch", candidate]
      : ["check-ref-format", `refs/tags/${candidate}`];
  if ((await gitOrNull(repoPath, args)) === null) {
    throw new Error(`"${candidate}" is not a valid ${kind} name.`);
  }
  return candidate;
}

async function isMergeCommit(repoPath: string, hash: string): Promise<boolean> {
  const parents = (await gitOrNull(repoPath, ["rev-list", "--parents", "-n", "1", hash])) ?? "";
  return parents.trim().split(" ").length > 2;
}

function actionArgs(
  kind: ZodOutput<typeof actionRpc.input>["kind"],
  input: ZodOutput<typeof actionRpc.input>,
  name: string | null,
  mergeCommit: boolean,
): string[] {
  switch (kind) {
    case "checkout":
      return ["checkout", input.hash];
    case "create-branch":
      return ["branch", name!, input.hash];
    case "create-tag":
      return input.message?.trim()
        ? ["tag", "-a", "-m", input.message.trim(), name!, input.hash]
        : ["tag", name!, input.hash];
    case "cherry-pick":
      // A merge has no single "the" change, so git needs to be told which parent to diff against.
      return mergeCommit
        ? ["cherry-pick", "-m", "1", input.hash]
        : ["cherry-pick", input.hash];
    case "revert":
      return mergeCommit
        ? ["revert", "--no-edit", "-m", "1", input.hash]
        : ["revert", "--no-edit", input.hash];
    case "merge":
      return input.noFastForward
        ? ["merge", "--no-ff", "--no-edit", input.hash]
        : ["merge", "--no-edit", input.hash];
    case "reset":
      return ["reset", `--${input.resetMode}`, input.hash];
  }
}

/**
 * Runs one context-menu action. Every argument is either a fixed string, a validated hash, or a
 * name git itself accepted, and nothing goes through a shell.
 */
export async function runAction(
  input: ZodOutput<typeof actionRpc.input>,
): Promise<{ output: string }> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  if (!HASH_PATTERN.test(input.hash)) throw new Error(`Invalid commit hash: ${input.hash}`);

  const name =
    input.kind === "create-branch"
      ? await assertRefName(repoPath, "branch", input.name ?? "")
      : input.kind === "create-tag"
        ? await assertRefName(repoPath, "tag", input.name ?? "")
        : null;

  const needsParent = input.kind === "cherry-pick" || input.kind === "revert";
  const mergeCommit = needsParent ? await isMergeCommit(repoPath, input.hash) : false;

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      actionArgs(input.kind, input, name, mergeCommit),
      { cwd: repoPath, maxBuffer: MAX_BUFFER },
    );
    let output = `${stdout}${stderr}`.trim();
    if (input.kind === "create-branch" && input.checkoutAfterCreate) {
      // The branch already exists at this point. A failed checkout must not read as a failed
      // create, or the obvious retry hits "branch already exists" and hides the real reason.
      try {
        const checkout = await execFileAsync("git", ["checkout", name!], {
          cwd: repoPath,
          maxBuffer: MAX_BUFFER,
        });
        output = `${output}\n${checkout.stdout}${checkout.stderr}`.trim();
      } catch (checkoutError) {
        const details = checkoutError as { stderr?: unknown; message?: string };
        const reason =
          typeof details.stderr === "string" && details.stderr.trim()
            ? details.stderr.trim()
            : (details.message ?? "checkout failed");
        output = `Created ${name}, but could not check it out:\n${reason}`;
      }
    }
    return { output: output || "Done." };
  } catch (error) {
    // git puts the useful part (conflicts, "would be overwritten") on stderr before exiting.
    const details = error as { stderr?: unknown; stdout?: unknown; message?: string };
    const text = [details.stderr, details.stdout]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    throw new Error(text || details.message || "git failed");
  }
}

/** Splits `origin/feature/x` into its remote and the branch name on that remote. */
function splitRemoteRef(ref: string, remotes: readonly string[]): { remote: string; branch: string } | null {
  for (const remote of remotes) {
    if (ref.startsWith(`${remote}/`)) return { remote, branch: ref.slice(remote.length + 1) };
  }
  return null;
}

function refActionArgs(
  input: ZodOutput<typeof refActionRpc.input>,
  newName: string | null,
  remoteRef: { remote: string; branch: string } | null,
): string[] {
  switch (input.kind) {
    case "checkout-branch":
      return ["checkout", input.ref];
    case "checkout-remote":
      return ["checkout", "-b", newName!, input.ref];
    case "rename-branch":
      return ["branch", "-m", input.ref, newName!];
    case "delete-branch":
      return ["branch", input.force ? "-D" : "-d", input.ref];
    case "delete-remote-branch":
      return ["push", remoteRef!.remote, "--delete", remoteRef!.branch];
    case "merge-ref":
      return input.noFastForward
        ? ["merge", "--no-ff", "--no-edit", input.ref]
        : ["merge", "--no-edit", input.ref];
    case "pull-ref":
      return input.noFastForward
        ? ["pull", "--no-ff", "--no-edit", remoteRef!.remote, remoteRef!.branch]
        : ["pull", "--no-edit", remoteRef!.remote, remoteRef!.branch];
    case "fetch-into-local":
      return ["fetch", remoteRef!.remote, `${remoteRef!.branch}:${newName!}`];
    case "push-branch":
      return [
        "push",
        ...(input.setUpstream ? ["--set-upstream"] : []),
        ...(input.force ? ["--force-with-lease"] : []),
        input.remote!,
        input.ref,
      ];
    case "push-tag":
      return ["push", input.remote!, `refs/tags/${input.ref}`];
    case "delete-tag":
      return ["tag", "-d", input.ref];
  }
}

/**
 * Runs an action from a branch, remote-branch, or tag label. The ref has to be one git already
 * lists, and any new name goes through `check-ref-format`, so neither can reach git as an option.
 */
export async function runRefAction(
  input: ZodOutput<typeof refActionRpc.input>,
): Promise<{ output: string }> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  const { branches, remoteBranches, remotes } = await listBranches({
    root: input.root,
    repoPath: input.repoPath,
  });
  const tags = ((await gitOrNull(repoPath, ["tag", "--list"])) ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const wantsTag = input.kind === "delete-tag" || input.kind === "push-tag";
  const known = wantsTag ? tags : [...branches, ...remoteBranches];
  if (!known.includes(input.ref)) throw new Error(`Unknown ref: ${input.ref}`);

  const remoteRef = splitRemoteRef(input.ref, remotes);
  const needsRemoteRef =
    input.kind === "delete-remote-branch" ||
    input.kind === "pull-ref" ||
    input.kind === "fetch-into-local";
  if (needsRemoteRef && !remoteRef) throw new Error(`${input.ref} is not a remote branch.`);

  if ((input.kind === "push-branch" || input.kind === "push-tag") && !remotes.includes(input.remote ?? "")) {
    throw new Error(`Unknown remote: ${input.remote ?? ""}`);
  }

  const needsName =
    input.kind === "checkout-remote" ||
    input.kind === "rename-branch" ||
    input.kind === "fetch-into-local";
  const newName = needsName ? await assertRefName(repoPath, "branch", input.newName ?? "") : null;
  if (newName && branches.includes(newName) && input.kind !== "rename-branch") {
    throw new Error(`A branch named ${newName} already exists.`);
  }

  try {
    const { stdout, stderr } = await execFileAsync(
      "git",
      refActionArgs(input, newName, remoteRef),
      { cwd: repoPath, maxBuffer: MAX_BUFFER, timeout: FETCH_TIMEOUT_MS },
    );
    return { output: `${stdout}${stderr}`.trim() || "Done." };
  } catch (error) {
    const details = error as { stderr?: unknown; stdout?: unknown; message?: string };
    const text = [details.stderr, details.stdout]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n")
      .trim();
    throw new Error(text || details.message || "git failed");
  }
}

/**
 * Panel preferences live next to the daemon's own state rather than in the plugin directory, so a
 * `git pull` of the plugin source never fights with them. One entry per workspace root.
 */
function preferencesFile(): string {
  const home = process.env.PASEO_HOME ?? path.join(os.homedir(), ".paseo");
  return path.join(home, "plugin-git-graph.json");
}

async function readAllPreferences(): Promise<Record<string, Preferences>> {
  try {
    const raw = await readFile(preferencesFile(), "utf8");
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, Preferences>) : {};
  } catch {
    return {};
  }
}

export async function readPreferences(
  input: ZodOutput<typeof readPrefsRpc.input>,
): Promise<{ preferences: Preferences | null }> {
  const all = await readAllPreferences();
  return { preferences: all[realPath(path.resolve(input.root))] ?? null };
}

export async function writePreferences(
  input: ZodOutput<typeof writePrefsRpc.input>,
): Promise<{ saved: boolean }> {
  const file = preferencesFile();
  const all = await readAllPreferences();
  all[realPath(path.resolve(input.root))] = input.preferences;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(all, null, 2)}\n`, "utf8");
  return { saved: true };
}

/**
 * Cheap change detector: every ref, HEAD, and the porcelain status, hashed. Polled by the panel
 * instead of a file watcher, so it has to cover uncommitted edits too.
 */
export async function readSignature(
  input: ZodOutput<typeof signatureRpc.input>,
): Promise<{ signature: string }> {
  const repoPath = await assertAllowed(input.root, input.repoPath);
  const refs =
    (await gitOrNull(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)"])) ?? "";
  const head = (await gitOrNull(repoPath, ["rev-parse", "HEAD"])) ?? "";
  const status =
    (await gitOrNull(repoPath, ["status", "--porcelain=v1", "--untracked-files=all"])) ?? "";
  return {
    signature: createHash("sha1").update(refs).update(head).update(status).digest("hex"),
  };
}
