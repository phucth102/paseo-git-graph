import { defineRpc } from "@getpaseo/plugin/server";
import { z } from "zod";

export const RefSchema = z.object({
  name: z.string(),
  type: z.enum(["head", "branch", "remote", "tag", "stash"]),
});

export const CommitSchema = z.object({
  hash: z.string(),
  parents: z.array(z.string()),
  author: z.string(),
  date: z.number(),
  subject: z.string(),
  refs: z.array(RefSchema),
});

export const RepoSchema = z.object({
  path: z.string(),
  name: z.string(),
  isSubmodule: z.boolean(),
});

export type Ref = z.output<typeof RefSchema>;
export type Commit = z.output<typeof CommitSchema>;
export type Repo = z.output<typeof RepoSchema>;

export const DEFAULT_PAGE_SIZE = 300;

/** Hash of the synthetic row that stands for the working tree, above the newest commit. */
export const WORKING_TREE_ID = "working-tree";

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.string(),
  additions: z.number().nullable(),
  deletions: z.number().nullable(),
});

export type ChangedFile = z.output<typeof ChangedFileSchema>;

export const reposRpc = defineRpc({
  name: "gitgraph.repos",
  input: z.object({ root: z.string() }),
  output: z.object({ repos: z.array(RepoSchema) }),
});

export const branchesRpc = defineRpc({
  name: "gitgraph.branches",
  input: z.object({ root: z.string(), repoPath: z.string() }),
  output: z.object({
    branches: z.array(z.string()),
    remoteBranches: z.array(z.string()),
    remotes: z.array(z.string()),
    head: z.string().nullable(),
  }),
});

export const logRpc = defineRpc({
  name: "gitgraph.log",
  input: z.object({
    root: z.string(),
    repoPath: z.string(),
    limit: z.number().int().positive().max(5000).default(DEFAULT_PAGE_SIZE),
    /** A single branch to walk, or null for every branch. */
    branch: z.string().nullable().default(null),
    showRemotes: z.boolean().default(true),
  }),
  output: z.object({
    commits: z.array(CommitSchema),
    headHash: z.string().nullable(),
    headLabel: z.string().nullable(),
    moreAvailable: z.boolean(),
    uncommittedCount: z.number(),
  }),
});

export const commitDetailRpc = defineRpc({
  name: "gitgraph.commit-detail",
  input: z.object({
    root: z.string(),
    repoPath: z.string(),
    hash: z.string(),
  }),
  output: z.object({
    body: z.string(),
    authorEmail: z.string(),
    committer: z.string(),
    committerEmail: z.string(),
    files: z.array(ChangedFileSchema),
    truncatedFiles: z.boolean(),
  }),
});

export const workingTreeRpc = defineRpc({
  name: "gitgraph.working-tree",
  input: z.object({ root: z.string(), repoPath: z.string() }),
  output: z.object({
    files: z.array(ChangedFileSchema),
    count: z.number(),
    truncatedFiles: z.boolean(),
  }),
});

export const fileDiffRpc = defineRpc({
  name: "gitgraph.file-diff",
  input: z.object({
    root: z.string(),
    repoPath: z.string(),
    /** A commit hash, or WORKING_TREE_ID for the uncommitted state. */
    hash: z.string(),
    path: z.string().min(1),
  }),
  output: z.object({
    lines: z.array(z.string()),
    truncated: z.boolean(),
    /** Set when the file has no textual diff at all (binary, or a submodule pointer). */
    note: z.string().nullable(),
  }),
});

export const fetchRpc = defineRpc({
  name: "gitgraph.fetch",
  input: z.object({ root: z.string(), repoPath: z.string() }),
  output: z.object({ output: z.string() }),
});

export const PreferencesSchema = z.object({
  repoPath: z.string().nullable(),
  branch: z.string().nullable(),
  showRemotes: z.boolean(),
});

export type Preferences = z.output<typeof PreferencesSchema>;

export const readPrefsRpc = defineRpc({
  name: "gitgraph.prefs.read",
  input: z.object({ root: z.string() }),
  output: z.object({ preferences: PreferencesSchema.nullable() }),
});

export const writePrefsRpc = defineRpc({
  name: "gitgraph.prefs.write",
  input: z.object({ root: z.string(), preferences: PreferencesSchema }),
  output: z.object({ saved: z.boolean() }),
});

/** Everything the context menu can run. All of these write to the repository. */
export const ACTION_KINDS = [
  "checkout",
  "create-branch",
  "create-tag",
  "cherry-pick",
  "revert",
  "merge",
  "reset",
] as const;

export const RESET_MODES = ["soft", "mixed", "hard"] as const;

export const actionRpc = defineRpc({
  name: "gitgraph.action",
  input: z.object({
    root: z.string(),
    repoPath: z.string(),
    kind: z.enum(ACTION_KINDS),
    hash: z.string(),
    /** Branch or tag name, for the two creating actions. */
    name: z.string().optional(),
    /** Annotation message for a tag. */
    message: z.string().optional(),
    checkoutAfterCreate: z.boolean().default(false),
    resetMode: z.enum(RESET_MODES).default("mixed"),
    noFastForward: z.boolean().default(true),
  }),
  output: z.object({ output: z.string() }),
});

/** Actions that hang off a branch, remote branch, or tag label. */
export const REF_ACTION_KINDS = [
  "checkout-branch",
  "checkout-remote",
  "rename-branch",
  "delete-branch",
  "delete-remote-branch",
  "merge-ref",
  "pull-ref",
  "fetch-into-local",
  "push-branch",
  "push-tag",
  "delete-tag",
] as const;

export type RefActionKind = (typeof REF_ACTION_KINDS)[number];

export const refActionRpc = defineRpc({
  name: "gitgraph.ref-action",
  input: z.object({
    root: z.string(),
    repoPath: z.string(),
    kind: z.enum(REF_ACTION_KINDS),
    /** Short ref name: `main`, `origin/main`, or a tag. */
    ref: z.string(),
    /** New local branch name, for checkout-remote / rename / fetch-into-local. */
    newName: z.string().optional(),
    remote: z.string().optional(),
    force: z.boolean().default(false),
    setUpstream: z.boolean().default(false),
    noFastForward: z.boolean().default(true),
  }),
  output: z.object({ output: z.string() }),
});

export const signatureRpc = defineRpc({
  name: "gitgraph.signature",
  input: z.object({ root: z.string(), repoPath: z.string() }),
  output: z.object({ signature: z.string() }),
});
