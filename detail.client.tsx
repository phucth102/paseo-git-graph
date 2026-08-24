import React, { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useQuery } from "@tanstack/react-query";
import { type PluginTheme, useRpc } from "@getpaseo/plugin";
import {
  WORKING_TREE_ID,
  commitDetailRpc,
  fileDiffRpc,
  workingTreeRpc,
  type ChangedFile,
  type Commit,
} from "./graph.shared";
import { fileStatusColor, fileStatusKind, withAlpha } from "./colors.client";
import { MONOSPACE, formatDate } from "./graph-row.client";

export function detailHeight(compact: boolean): number {
  return compact ? 320 : 260;
}

type TreeRow =
  | { kind: "folder"; key: string; name: string; path: string; depth: number; collapsed: boolean }
  | { kind: "file"; key: string; name: string; depth: number; file: ChangedFile };

interface FolderNode {
  folders: Map<string, FolderNode>;
  files: ChangedFile[];
}

function emptyFolder(): FolderNode {
  return { folders: new Map(), files: [] };
}

/** Groups paths into the folder tree Git Graph shows on the right of a commit. */
function buildTree(files: readonly ChangedFile[]): FolderNode {
  const root = emptyFolder();
  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      let child = node.folders.get(part);
      if (!child) {
        child = emptyFolder();
        node.folders.set(part, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

function flattenTree(node: FolderNode, collapsed: ReadonlySet<string>, prefix = "", depth = 0): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const name of [...node.folders.keys()].sort()) {
    let label = name;
    let path = prefix ? `${prefix}/${name}` : name;
    let child = node.folders.get(name)!;
    // A folder that only holds one folder is joined onto its parent — `services / providers` —
    // so the tree does not waste a row per path segment.
    while (child.files.length === 0 && child.folders.size === 1) {
      const [onlyName, onlyChild] = [...child.folders.entries()][0]!;
      label = `${label} / ${onlyName}`;
      path = `${path}/${onlyName}`;
      child = onlyChild;
    }
    const isCollapsed = collapsed.has(path);
    rows.push({ kind: "folder", key: `folder:${path}`, name: label, path, depth, collapsed: isCollapsed });
    if (!isCollapsed) rows.push(...flattenTree(child, collapsed, path, depth + 1));
  }
  for (const file of [...node.files].sort((a, b) => a.path.localeCompare(b.path))) {
    const name = file.path.slice(file.path.lastIndexOf("/") + 1);
    rows.push({ kind: "file", key: `file:${file.path}`, name, depth, file });
  }
  return rows;
}

function FileList({
  files,
  theme,
  tree,
  onOpen,
}: {
  files: readonly ChangedFile[];
  theme: PluginTheme;
  tree: boolean;
  onOpen: (path: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const toggle = useCallback((path: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rows = useMemo(() => {
    if (!tree) {
      return [...files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .map<TreeRow>((file) => ({ kind: "file", key: `flat:${file.path}`, name: file.path, depth: 0, file }));
    }
    return flattenTree(buildTree(files), collapsed);
  }, [files, tree, collapsed]);

  return (
    <>
      {rows.map((row) =>
        row.kind === "folder" ? (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={`${row.collapsed ? "Expand" : "Collapse"} ${row.name}`}
            onPress={() => toggle(row.path)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              paddingVertical: 1,
              paddingLeft: 10 * row.depth,
            }}
          >
            <Text style={{ fontSize: 10, color: theme.colors.foregroundMuted, width: 12 }}>
              {row.collapsed ? "▸" : "▾"}
            </Text>
            <Text numberOfLines={1} style={{ fontSize: 12, color: theme.colors.foreground }}>
              {row.name}
            </Text>
          </Pressable>
        ) : (
          <Pressable
            key={row.key}
            accessibilityRole="button"
            accessibilityLabel={`Show the diff for ${row.file.path}`}
            onPress={() => onOpen(row.file.path)}
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              paddingVertical: 1,
              paddingLeft: 10 * row.depth + 14,
            }}
          >
            <Text numberOfLines={1} style={{ fontSize: 12 }}>
              <Text style={{ color: fileStatusColor(row.file.status, theme.colors.surface0) }}>
                {row.name}
              </Text>
              {row.file.additions === null ? (
                <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
                  {`  (${fileStatusKind(row.file.status)})`}
                </Text>
              ) : (
                <>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{"  ( "}</Text>
                  <Text style={{ color: fileStatusColor("A", theme.colors.surface0), fontSize: 11 }}>
                    {`+${row.file.additions}`}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{" | "}</Text>
                  <Text style={{ color: fileStatusColor("D", theme.colors.surface0), fontSize: 11 }}>
                    {`−${row.file.deletions}`}
                  </Text>
                  <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>{" )"}</Text>
                </>
              )}
            </Text>
          </Pressable>
        ),
      )}
    </>
  );
}

function diffLineColor(line: string, theme: PluginTheme, background: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff --git")) {
    return theme.colors.foregroundMuted;
  }
  if (line.startsWith("@@")) return theme.colors.accent;
  if (line.startsWith("+")) return fileStatusColor("A", background);
  if (line.startsWith("-")) return fileStatusColor("D", background);
  return theme.colors.foreground;
}


interface SplitCell {
  number: number | null;
  text: string | null;
}

interface SplitRow {
  key: string;
  kind: "meta" | "hunk" | "context" | "change";
  left: SplitCell;
  right: SplitCell;
  full?: string;
}

const EMPTY_CELL: SplitCell = { number: null, text: null };

/**
 * Turns a unified patch into aligned left/right rows. Removed and added runs inside one hunk are
 * paired up so a modified line sits opposite its replacement, the way a side-by-side diff reads.
 */
export function toSplitRows(lines: readonly string[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let leftNumber = 0;
  let rightNumber = 0;
  let removed: string[] = [];
  let added: string[] = [];

  const flush = () => {
    const pairs = Math.max(removed.length, added.length);
    for (let index = 0; index < pairs; index += 1) {
      const left = removed[index];
      const right = added[index];
      rows.push({
        key: `change:${rows.length}`,
        kind: "change",
        left: left === undefined ? EMPTY_CELL : { number: (leftNumber += 1), text: left },
        right: right === undefined ? EMPTY_CELL : { number: (rightNumber += 1), text: right },
      });
    }
    removed = [];
    added = [];
  };

  for (const line of lines) {
    if (line.startsWith("@@")) {
      flush();
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      leftNumber = match ? Number(match[1]) - 1 : 0;
      rightNumber = match ? Number(match[2]) - 1 : 0;
      rows.push({ key: `hunk:${rows.length}`, kind: "hunk", left: EMPTY_CELL, right: EMPTY_CELL, full: line });
      continue;
    }
    if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("new file") ||
      line.startsWith("deleted file") ||
      line.startsWith("similarity index") ||
      line.startsWith("rename ") ||
      line.startsWith("old mode") ||
      line.startsWith("new mode") ||
      line.startsWith("Binary files")
    ) {
      flush();
      rows.push({ key: `meta:${rows.length}`, kind: "meta", left: EMPTY_CELL, right: EMPTY_CELL, full: line });
      continue;
    }
    if (line.startsWith("-")) {
      removed.push(line.slice(1));
      continue;
    }
    if (line.startsWith("+")) {
      added.push(line.slice(1));
      continue;
    }
    flush();
    const text = line.startsWith(" ") ? line.slice(1) : line;
    rows.push({
      key: `context:${rows.length}`,
      kind: "context",
      left: { number: (leftNumber += 1), text },
      right: { number: (rightNumber += 1), text },
    });
  }
  flush();
  return rows;
}

function SplitSide({
  cell,
  changed,
  theme,
  tint,
}: {
  cell: SplitCell;
  changed: boolean;
  theme: PluginTheme;
  tint: string;
}) {
  return (
    <View
      style={{
        flex: 1,
        flexDirection: "row",
        backgroundColor: changed && cell.text !== null ? tint : "transparent",
      }}
    >
      <Text
        style={{
          width: 42,
          textAlign: "right",
          paddingRight: 6,
          fontFamily: MONOSPACE,
          fontSize: 11,
          lineHeight: 15,
          color: withAlpha(theme.colors.foregroundMuted, "aa", theme.colors.foregroundMuted),
        }}
      >
        {cell.number ?? ""}
      </Text>
      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          fontFamily: MONOSPACE,
          fontSize: 11,
          lineHeight: 15,
          color: cell.text === null ? theme.colors.foregroundMuted : theme.colors.foreground,
        }}
      >
        {cell.text ?? ""}
      </Text>
    </View>
  );
}

function SplitDiff({ lines, theme }: { lines: readonly string[]; theme: PluginTheme }) {
  const rows = useMemo(() => toSplitRows(lines), [lines]);
  const removedTint = withAlpha(fileStatusColor("D", theme.colors.surface0), "26", "transparent");
  const addedTint = withAlpha(fileStatusColor("A", theme.colors.surface0), "26", "transparent");

  return (
    <>
      {rows.map((row) =>
        row.full !== undefined ? (
          <Text
            key={row.key}
            numberOfLines={1}
            style={{
              fontFamily: MONOSPACE,
              fontSize: 11,
              lineHeight: 15,
              color: row.kind === "hunk" ? theme.colors.accent : theme.colors.foregroundMuted,
            }}
          >
            {row.full}
          </Text>
        ) : (
          <View key={row.key} style={{ flexDirection: "row", gap: 8 }}>
            <SplitSide cell={row.left} changed={row.kind === "change"} theme={theme} tint={removedTint} />
            <SplitSide cell={row.right} changed={row.kind === "change"} theme={theme} tint={addedTint} />
          </View>
        ),
      )}
    </>
  );
}

function DiffView({
  theme,
  root,
  repoPath,
  hash,
  path,
  onBack,
}: {
  theme: PluginTheme;
  root: string;
  repoPath: string;
  hash: string;
  path: string;
  onBack: () => void;
}) {
  const callFileDiff = useRpc(fileDiffRpc);
  const [split, setSplit] = useState(false);
  const query = useQuery({
    queryKey: ["git-graph", "file-diff", root, repoPath, hash, path],
    queryFn: () => callFileDiff({ root, repoPath, hash, path }),
  });

  return (
    <View style={{ flex: 1, padding: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 }}>
        <Pressable accessibilityRole="button" accessibilityLabel="Back to the file list" onPress={onBack}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>← Files</Text>
        </Pressable>
        <Text numberOfLines={1} style={{ flex: 1, color: theme.colors.foreground, fontSize: 12 }}>
          {path}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={split ? "Show a unified diff" : "Show a side-by-side diff"}
          onPress={() => setSplit((current) => !current)}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11 }}>
            {split ? "Unified" : "Side by side"}
          </Text>
        </Pressable>
      </View>
      <ScrollView horizontal={!split} contentContainerStyle={split ? { flex: 1 } : undefined}>
        <ScrollView style={split ? { flex: 1 } : undefined}>
          {query.isPending ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Loading diff…</Text>
          ) : null}
          {query.error ? (
            <Text style={{ color: theme.colors.statusDanger, fontSize: 12 }}>
              {(query.error as Error).message}
            </Text>
          ) : null}
          {query.data?.note ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
              {query.data.note}
            </Text>
          ) : null}
          {split && query.data ? <SplitDiff lines={query.data.lines} theme={theme} /> : null}
          {!split &&
            query.data?.lines.map((line, index) => (
              <Text
                key={`${index}:${line.slice(0, 24)}`}
                style={{
                  fontFamily: MONOSPACE,
                  fontSize: 11,
                  lineHeight: 15,
                  color: diffLineColor(line, theme, theme.colors.surface0),
                }}
              >
                {line.length > 0 ? line : " "}
              </Text>
            ))}
          {query.data?.truncated ? (
            <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 6 }}>
              Diff truncated at 1200 lines.
            </Text>
          ) : null}
        </ScrollView>
      </ScrollView>
    </View>
  );
}

export interface DetailPaneProps {
  theme: PluginTheme;
  compact: boolean;
  root: string;
  repoPath: string;
  commit: Commit;
  onClose: () => void;
  /** Jumps to another commit — used by the parent links. */
  onSelectCommit: (hash: string) => void;
}

/**
 * The expanded row under a commit: message and metadata on the left, changed files on the right,
 * the same split Git Graph uses.
 */
export function DetailPane({
  theme,
  compact,
  root,
  repoPath,
  commit,
  onClose,
  onSelectCommit,
}: DetailPaneProps) {
  const callDetail = useRpc(commitDetailRpc);
  const callWorkingTree = useRpc(workingTreeRpc);
  const isWorkingTree = commit.hash === WORKING_TREE_ID;
  const [tree, setTree] = useState(true);
  const [openFile, setOpenFile] = useState<string | null>(null);

  const commitQuery = useQuery({
    queryKey: ["git-graph", "detail", root, repoPath, commit.hash],
    queryFn: () => callDetail({ root, repoPath, hash: commit.hash }),
    enabled: !isWorkingTree,
  });
  const workingTreeQuery = useQuery({
    queryKey: ["git-graph", "working-tree", root, repoPath],
    queryFn: () => callWorkingTree({ root, repoPath }),
    enabled: isWorkingTree,
  });

  const active = isWorkingTree ? workingTreeQuery : commitQuery;
  const files = (isWorkingTree ? workingTreeQuery.data?.files : commitQuery.data?.files) ?? [];
  const truncated =
    (isWorkingTree ? workingTreeQuery.data?.truncatedFiles : commitQuery.data?.truncatedFiles) ??
    false;

  const styles = useMemo(
    () => ({
      container: {
        height: detailHeight(compact),
        flexDirection: compact ? ("column" as const) : ("row" as const),
        borderTopWidth: 1,
        borderBottomWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "33"),
        backgroundColor: withAlpha(theme.colors.foregroundMuted, "0d", theme.colors.surface0),
      },
      left: { flex: 1, padding: 12 },
      right: {
        width: compact ? undefined : "44%",
        flex: compact ? 1 : undefined,
        padding: 12,
        borderLeftWidth: compact ? 0 : 1,
        borderTopWidth: compact ? 1 : 0,
        borderColor: withAlpha(theme.colors.foregroundMuted, "33"),
      } as const,
      body: { color: theme.colors.foreground, fontSize: 13, marginTop: 12 },
      line: { fontSize: 12, marginBottom: 2 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const },
      value: { color: theme.colors.foreground, fontSize: 12 },
      link: { color: theme.colors.accent, fontSize: 12, textDecorationLine: "underline" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      action: { color: theme.colors.foregroundMuted, fontSize: 11 },
    }),
    [theme, compact],
  );

  /** `Mon Aug 24 2026 10:05:18 GMT+0700 (Indochina Time)`, the same stamp Git Graph prints. */
  const fullDate = (seconds: number) => new Date(seconds * 1000).toString();

  const author = commitQuery.data?.authorEmail
    ? `${commit.author} <${commitQuery.data.authorEmail}>`
    : commit.author;
  const committer = commitQuery.data?.committerEmail
    ? `${commitQuery.data.committer} <${commitQuery.data.committerEmail}>`
    : commitQuery.data?.committer;

  return (
    <View style={styles.container}>
      <View style={styles.left}>
        <ScrollView>
          {active.isPending ? <Text style={styles.muted}>Loading…</Text> : null}
          {active.error ? (
            <Text style={styles.danger}>{(active.error as Error).message}</Text>
          ) : null}

          {isWorkingTree ? (
            <Text style={styles.body}>
              Displaying all uncommitted changes
              {workingTreeQuery.data ? ` (${workingTreeQuery.data.count})` : ""}. Staged, unstaged
              and untracked files are listed together.
            </Text>
          ) : (
            <>
              <Text style={styles.line}>
                <Text style={styles.label}>Commit: </Text>
                <Text style={[styles.value, { fontFamily: MONOSPACE }]}>{commit.hash}</Text>
              </Text>
              <Text style={styles.line}>
                <Text style={styles.label}>Parents: </Text>
                {commit.parents.length === 0 ? (
                  <Text style={styles.value}>none</Text>
                ) : (
                  commit.parents.map((parent, index) => (
                    <Text key={parent}>
                      {index > 0 ? <Text style={styles.value}>, </Text> : null}
                      <Text
                        accessibilityRole="link"
                        accessibilityLabel={`Show parent ${parent.slice(0, 8)}`}
                        onPress={() => onSelectCommit(parent)}
                        style={[styles.link, { fontFamily: MONOSPACE }]}
                      >
                        {parent}
                      </Text>
                    </Text>
                  ))
                )}
              </Text>
              <Text style={styles.line}>
                <Text style={styles.label}>Author: </Text>
                <Text style={styles.value}>{author}</Text>
              </Text>
              {committer ? (
                <Text style={styles.line}>
                  <Text style={styles.label}>Committer: </Text>
                  <Text style={styles.value}>{committer}</Text>
                </Text>
              ) : null}
              <Text style={styles.line}>
                <Text style={styles.label}>Date: </Text>
                <Text style={styles.value}>{fullDate(commit.date)}</Text>
              </Text>
              <Text style={styles.body}>{commitQuery.data?.body ?? commit.subject}</Text>
            </>
          )}
        </ScrollView>
      </View>

      <View style={styles.right}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <Text style={styles.muted}>
            {files.length} file{files.length === 1 ? "" : "s"}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={tree ? "Show a flat file list" : "Show the file tree"}
            onPress={() => setTree((current) => !current)}
          >
            <Text style={styles.action}>{tree ? "Flat list" : "Tree"}</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Close details" onPress={onClose}>
            <Text style={styles.action}>Close ✕</Text>
          </Pressable>
        </View>
        <ScrollView>
          <FileList files={files} theme={theme} tree={tree} onOpen={setOpenFile} />
          {truncated ? (
            <Text style={[styles.muted, { marginTop: 6 }]}>Showing the first 400 files.</Text>
          ) : null}
        </ScrollView>
      </View>
    </View>
  );
}
