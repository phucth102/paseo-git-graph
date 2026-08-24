import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type PluginTheme, type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin";
import {
  DEFAULT_PAGE_SIZE,
  WORKING_TREE_ID,
  branchesRpc,
  fetchRpc,
  refActionRpc,
  logRpc,
  readPrefsRpc,
  reposRpc,
  signatureRpc,
  writePrefsRpc,
  type Commit,
  type RefActionKind,
} from "./graph.shared";
import { layoutCommits } from "./layout.client";
import { graphPalette, withAlpha } from "./colors.client";
import { ColumnHeaderRow, CommitRow, rowHeight, type RefPress } from "./graph-row.client";
import { DetailPane, detailHeight } from "./detail.client";
import {
  ActionDialog,
  CommitMenu,
  RefDialog,
  RefMenu,
  copyText,
  type MenuAction,
  type MenuTarget,
  type RefTarget,
} from "./actions.client";

const SIGNATURE_POLL_MS = 4000;
const ALL_BRANCHES = "Show All";

type ListItem =
  | { kind: "commit"; commit: Commit; index: number }
  | { kind: "detail"; commit: Commit };

interface PickerOption {
  key: string;
  label: string;
  indented: boolean;
}

function Picker({
  theme,
  options,
  selected,
  onSelect,
  anchor,
  width,
}: {
  theme: PluginTheme;
  options: readonly PickerOption[];
  selected: string;
  onSelect: (key: string) => void;
  /** Panel-local position of the control this list drops out of. */
  anchor: { x: number; y: number };
  width: number;
}) {
  return (
    <View
      style={{
        position: "absolute",
        top: anchor.y,
        left: anchor.x,
        width,
        maxHeight: 380,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
        backgroundColor: theme.colors.surface0,
        paddingVertical: 6,
        zIndex: 10,
      }}
    >
      <ScrollView>
        {options.map((option) => (
          <Pressable
            key={option.key}
            accessibilityRole="button"
            accessibilityLabel={`Show ${option.label}`}
            onPress={() => onSelect(option.key)}
            style={{
              paddingVertical: 7,
              paddingHorizontal: 12,
              paddingLeft: option.indented ? 24 : 12,
              backgroundColor:
                option.key === selected ? withAlpha(theme.colors.accent, "22") : "transparent",
            }}
          >
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 13 }}>
              {option.label}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

export function GitGraphPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const compact = layout.compact;
  const palette = useMemo(() => graphPalette(theme.colors.surface0), [theme.colors.surface0]);
  const queryClient = useQueryClient();

  const callRepos = useRpc(reposRpc);
  const callBranches = useRpc(branchesRpc);
  const callLog = useRpc(logRpc);
  const callSignature = useRpc(signatureRpc);
  const callFetch = useRpc(fetchRpc);
  const callRefAction = useRpc(refActionRpc);
  const callReadPrefs = useRpc(readPrefsRpc);
  const callWritePrefs = useRpc(writePrefsRpc);

  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [branch, setBranch] = useState<string | null>(null);
  const [showRemotes, setShowRemotes] = useState(true);
  const [limit, setLimit] = useState(DEFAULT_PAGE_SIZE);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [picker, setPicker] = useState<"repo" | "branch" | null>(null);
  const [search, setSearch] = useState("");
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [pending, setPending] = useState<{ commit: Commit; action: MenuAction } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  const [refMenu, setRefMenu] = useState<RefTarget | null>(null);
  const [refPending, setRefPending] = useState<{ target: RefTarget; action: RefActionKind } | null>(
    null,
  );
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [repoAnchor, setRepoAnchor] = useState({ x: 14, y: 44 });
  const [branchAnchor, setBranchAnchor] = useState({ x: 14, y: 44 });
  const rootRef = useRef<View>(null);
  const repoButtonRef = useRef<View>(null);
  const branchButtonRef = useRef<View>(null);
  const [matchCursor, setMatchCursor] = useState(0);
  const listRef = useRef<FlatList<ListItem> | null>(null);

  const reposQuery = useQuery({
    queryKey: ["git-graph", "repos", directory],
    queryFn: () => callRepos({ root: directory! }),
    enabled: Boolean(directory),
  });

  const prefsQuery = useQuery({
    queryKey: ["git-graph", "prefs", directory],
    queryFn: () => callReadPrefs({ root: directory! }),
    enabled: Boolean(directory),
    staleTime: Infinity,
  });

  const repos = reposQuery.data?.repos ?? [];

  // Restore the last repository and branch once, and only if that repository is still there.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !prefsQuery.data || repos.length === 0) return;
    restored.current = true;
    const saved = prefsQuery.data.preferences;
    if (!saved) return;
    if (saved.repoPath && repos.some((repo) => repo.path === saved.repoPath)) {
      setSelectedRepo(saved.repoPath);
      setBranch(saved.branch);
    }
    setShowRemotes(saved.showRemotes);
  }, [prefsQuery.data, repos]);

  const repoPath = selectedRepo ?? repos[0]?.path ?? null;
  const activeRepo = repos.find((repo) => repo.path === repoPath) ?? null;

  const branchesQuery = useQuery({
    queryKey: ["git-graph", "branches", directory, repoPath],
    queryFn: () => callBranches({ root: directory!, repoPath: repoPath! }),
    enabled: Boolean(directory && repoPath),
  });

  const logQuery = useQuery({
    queryKey: ["git-graph", "log", directory, repoPath, limit, branch, showRemotes],
    queryFn: () => callLog({ root: directory!, repoPath: repoPath!, limit, branch, showRemotes }),
    enabled: Boolean(directory && repoPath),
    placeholderData: (previous) => previous,
  });

  const signatureQuery = useQuery({
    queryKey: ["git-graph", "signature", directory, repoPath],
    queryFn: () => callSignature({ root: directory!, repoPath: repoPath! }),
    enabled: Boolean(directory && repoPath),
    refetchInterval: SIGNATURE_POLL_MS,
  });

  // RPC is request/response only, so a cheap ref hash stands in for a filesystem watcher.
  // Only a *change* refetches the log: the first reading arrives with it and would double the work.
  const signature = signatureQuery.data?.signature;
  const lastSignature = useRef<{ repoPath: string | null; signature: string } | null>(null);
  useEffect(() => {
    if (!signature) return;
    const previous = lastSignature.current;
    lastSignature.current = { repoPath, signature };
    if (!previous || previous.repoPath !== repoPath || previous.signature === signature) return;
    for (const key of ["log", "working-tree", "branches"]) {
      void queryClient.invalidateQueries({ queryKey: ["git-graph", key, directory, repoPath] });
    }
  }, [signature, queryClient, directory, repoPath]);

  const commits = logQuery.data?.commits ?? [];
  const uncommittedCount = logQuery.data?.uncommittedCount ?? 0;
  const headHash = logQuery.data?.headHash ?? null;

  // A dirty working tree gets a synthetic row above the newest commit, parented to HEAD, so the
  // lane algorithm draws it as the tip of the current branch — the same shape Git Graph uses.
  const rows = useMemo<Commit[]>(() => {
    const showsHead = !headHash || commits.some((commit) => commit.hash === headHash);
    if (uncommittedCount === 0 || !showsHead) return commits;
    const workingTree: Commit = {
      hash: WORKING_TREE_ID,
      parents: headHash ? [headHash] : [],
      author: "",
      date: 0,
      subject: `Uncommitted Changes (${uncommittedCount})`,
      refs: [],
    };
    return [workingTree, ...commits];
  }, [commits, uncommittedCount, headHash]);

  const graph = useMemo(() => layoutCommits(rows), [rows]);
  const height = rowHeight(compact);
  const expandedHeight = detailHeight(compact);

  // Git Graph expands the detail in place rather than in a docked pane, so the list carries an
  // extra taller item right after the selected commit.
  const items = useMemo<ListItem[]>(() => {
    const list: ListItem[] = [];
    rows.forEach((commit, index) => {
      list.push({ kind: "commit", commit, index });
      if (commit.hash === selectedHash) list.push({ kind: "detail", commit });
    });
    return list;
  }, [rows, selectedHash]);

  // Mixed row heights mean offsets have to be accumulated for getItemLayout to stay correct.
  const offsets = useMemo(() => {
    const result: number[] = [];
    let offset = 0;
    for (const item of items) {
      result.push(offset);
      offset += item.kind === "detail" ? expandedHeight : height;
    }
    return result;
  }, [items, height, expandedHeight]);

  // Searching scrolls through hits instead of filtering: dropping rows would leave the lanes
  // describing a history that is not there.
  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return [];
    const hits: number[] = [];
    items.forEach((item, index) => {
      if (item.kind !== "commit") return;
      const { subject, author, hash } = item.commit;
      if (
        subject.toLowerCase().includes(needle) ||
        author.toLowerCase().includes(needle) ||
        hash.startsWith(needle)
      ) {
        hits.push(index);
      }
    });
    return hits;
  }, [items, search]);

  const matchedHashes = useMemo(
    () =>
      new Set(
        matches.map((index) => {
          const item = items[index];
          return item?.kind === "commit" ? item.commit.hash : "";
        }),
      ),
    [matches, items],
  );

  useEffect(() => setMatchCursor(0), [search]);
  useEffect(() => {
    const target = matches[matchCursor];
    if (target === undefined) return;
    listRef.current?.scrollToIndex({ index: target, animated: true, viewPosition: 0.35 });
  }, [matches, matchCursor]);

  // Persist the selection after the restore has had its turn, so it cannot overwrite itself.
  useEffect(() => {
    if (!directory || !restored.current || !repoPath) return;
    void callWritePrefs({ root: directory, preferences: { repoPath, branch, showRemotes } });
  }, [directory, repoPath, branch, showRemotes, callWritePrefs]);

  const fetchMutation = useMutation({
    mutationFn: () => callFetch({ root: directory!, repoPath: repoPath! }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["git-graph"] }),
  });

  /**
   * Anchors a dropdown under its button. React Native Web implements `onLayout` with a
   * ResizeObserver, so a control that only *moves* — when the repository name beside it gets
   * longer, say — never reports its new position. Measuring on open is the only reliable moment.
   */
  const openPicker = useCallback((which: "repo" | "branch", node: View | null) => {
    setPicker((current) => (current === which ? null : which));
    const root = rootRef.current;
    if (!node?.measureInWindow || !root?.measureInWindow) return;
    root.measureInWindow((rootX, rootY, rootWidth, rootHeight) => {
      setSize({ width: rootWidth, height: rootHeight });
      node.measureInWindow?.((buttonX, buttonY, _width, buttonHeight) => {
        const anchor = { x: buttonX - rootX, y: buttonY - rootY + buttonHeight + 4 };
        if (which === "repo") setRepoAnchor(anchor);
        else setBranchAnchor(anchor);
      });
    });
  }, []);

  // Press events carry window coordinates, but the menu is positioned inside the panel, which
  // starts below the tab bar and right of the sidebar. Without this subtraction the menu lands
  // far off to the bottom right of where it was opened.
  const openMenu = useCallback((commit: Commit, pageX: number, pageY: number) => {
    const node = rootRef.current;
    if (!node?.measureInWindow) {
      setMenu({ commit, x: pageX, y: pageY });
      return;
    }
    node.measureInWindow((x, y, width, height) => {
      setSize({ width, height });
      setMenu({ commit, x: pageX - x, y: pageY - y });
    });
  }, []);

  /** Panel-local coordinates for a press that arrived in window space. */
  const toLocal = useCallback(
    (pageX: number, pageY: number, apply: (x: number, y: number) => void) => {
      const node = rootRef.current;
      if (!node?.measureInWindow) {
        apply(pageX, pageY);
        return;
      }
      node.measureInWindow((x, y, width, height) => {
        setSize({ width, height });
        apply(pageX - x, pageY - y);
      });
    },
    [],
  );

  const finishAction = useCallback(
    (output: string) => {
      setNotice(output);
      void queryClient.invalidateQueries({ queryKey: ["git-graph"] });
    },
    [queryClient],
  );

  // Double-clicking a ref checks it out, exactly like Git Graph: local branches switch straight
  // away, remote ones ask what to call the local branch first.
  const activateRef = useCallback(
    (ref: RefPress) => {
      if (!directory || !repoPath || ref.isHead) return;
      if (ref.kind === "tag") return;
      if (ref.kind === "remote") {
        toLocal(ref.x, ref.y, (x, y) =>
          setRefPending({ target: { ...ref, x, y }, action: "checkout-remote" }),
        );
        return;
      }
      void callRefAction({
        root: directory,
        repoPath,
        kind: "checkout-branch",
        ref: ref.name,
        force: false,
        setUpstream: false,
        noFastForward: true,
      })
        .then((result) => finishAction(result.output))
        .catch((error: Error) => setNotice(error.message));
    },
    [directory, repoPath, callRefAction, finishAction, toLocal],
  );

  /**
   * Selects a commit and brings it into view — what the parent links do. The scroll waits for the
   * next render: selecting moves the expanded row, which shifts every index after it.
   */
  const selectCommit = useCallback(
    (hash: string) => {
      if (!rows.some((commit) => commit.hash === hash)) {
        setNotice(`${hash.slice(0, 8)} is not in the loaded history.`);
        return;
      }
      setSelectedHash(hash);
      setScrollTo(hash);
    },
    [rows],
  );

  useEffect(() => {
    if (!scrollTo) return;
    const index = items.findIndex((item) => item.kind === "commit" && item.commit.hash === scrollTo);
    setScrollTo(null);
    if (index === -1) return;
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.25 });
  }, [scrollTo, items]);

  const pickMenuAction = useCallback(
    (commit: Commit, action: MenuAction) => {
      setMenu(null);
      if (action === "copy-hash" || action === "copy-subject") {
        const value = action === "copy-hash" ? commit.hash : commit.subject;
        void copyText(value).then((copied) =>
          setNotice(copied ? `Copied ${action === "copy-hash" ? "hash" : "subject"}.` : "Clipboard unavailable."),
        );
        return;
      }
      setPending({ commit, action });
    },
    [],
  );

  const selectRepo = useCallback((path: string) => {
    setSelectedRepo(path);
    setSelectedHash(null);
    setBranch(null);
    setLimit(DEFAULT_PAGE_SIZE);
    setPicker(null);
  }, []);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 } as const,
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 8,
        paddingHorizontal: compact ? 10 : 14,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: withAlpha(theme.colors.foregroundMuted, "33"),
      },
      control: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
      },
      title: { color: theme.colors.foreground, fontSize: compact ? 13 : 13 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      action: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      actionText: { color: theme.colors.accentForeground, fontSize: 12 },
      search: {
        color: theme.colors.foreground,
        fontSize: 12,
        paddingHorizontal: 8,
        paddingVertical: 5,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
        width: compact ? 120 : 200,
      },
    }),
    [theme, compact],
  );

  if (!directory) {
    return (
      <View style={styles.screen}>
        <Text style={[styles.muted, { padding: 16 }]}>Loading workspace…</Text>
      </View>
    );
  }

  const error = reposQuery.error ?? logQuery.error ?? fetchMutation.error;
  const repoOptions: PickerOption[] = repos.map((repo) => ({
    key: repo.path,
    label: repo.name,
    indented: repo.isSubmodule,
  }));
  const branchOptions: PickerOption[] = [
    { key: ALL_BRANCHES, label: ALL_BRANCHES, indented: false },
    ...(branchesQuery.data?.branches ?? []).map((name) => ({
      key: name,
      label: name,
      indented: true,
    })),
    ...(showRemotes ? branchesQuery.data?.remoteBranches ?? [] : []).map((name) => ({
      key: name,
      label: name,
      indented: true,
    })),
  ];

  return (
    <View
      ref={rootRef}
      style={styles.screen}
      onLayout={(event) =>
        setSize({
          width: event.nativeEvent.layout.width,
          height: event.nativeEvent.layout.height,
        })
      }
    >
      <View style={styles.header}>
        {compact ? null : <Text style={styles.muted}>Repo:</Text>}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Choose repository"
          ref={repoButtonRef}
          onPress={() => openPicker("repo", repoButtonRef.current)}
          style={styles.control}
        >
          <Text style={styles.title}>{activeRepo?.name ?? "No repository"}</Text>
          <Text style={styles.muted}>▾</Text>
        </Pressable>

        {compact ? null : (
          <>
            <Text style={[styles.muted, { marginLeft: 6 }]}>Branches:</Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose branch"
              ref={branchButtonRef}
              onPress={() => openPicker("branch", branchButtonRef.current)}
              style={styles.control}
            >
              <Text style={styles.title}>{branch ?? ALL_BRANCHES}</Text>
              <Text style={styles.muted}>▾</Text>
            </Pressable>

            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: showRemotes }}
              accessibilityLabel="Show remote branches"
              onPress={() => setShowRemotes((current) => !current)}
              style={{ flexDirection: "row", alignItems: "center", gap: 6, marginLeft: 6 }}
            >
              <View
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  borderWidth: 1,
                  borderColor: showRemotes
                    ? theme.colors.accent
                    : withAlpha(theme.colors.foregroundMuted, "88", theme.colors.foregroundMuted),
                  backgroundColor: showRemotes ? theme.colors.accent : "transparent",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {showRemotes ? (
                  <Text style={{ fontSize: 10, color: theme.colors.accentForeground }}>✓</Text>
                ) : null}
              </View>
              <Text style={styles.muted}>Show Remote Branches</Text>
            </Pressable>
          </>
        )}

        <View style={{ flex: 1 }} />

        <TextInput
          accessibilityLabel="Search commits"
          placeholder="Search"
          placeholderTextColor={theme.colors.foregroundMuted}
          value={search}
          onChangeText={setSearch}
          style={styles.search}
        />
        {search.trim() ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
            <Text style={styles.muted}>
              {matches.length === 0 ? "0" : `${matchCursor + 1}/${matches.length}`}
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Previous match"
              onPress={() =>
                setMatchCursor((current) => (current - 1 + matches.length) % Math.max(matches.length, 1))
              }
            >
              <Text style={styles.muted}>▲</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Next match"
              onPress={() => setMatchCursor((current) => (current + 1) % Math.max(matches.length, 1))}
            >
              <Text style={styles.muted}>▼</Text>
            </Pressable>
          </View>
        ) : null}

        {compact ? null : (
          <Text style={styles.muted}>
            {commits.length}
            {logQuery.data?.moreAvailable ? "+" : ""}
          </Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Fetch from remotes"
          disabled={fetchMutation.isPending || !repoPath}
          onPress={() => fetchMutation.mutate()}
          style={[styles.control, { opacity: fetchMutation.isPending ? 0.6 : 1 }]}
        >
          <Text style={styles.title}>{fetchMutation.isPending ? "Fetching…" : "Fetch"}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Refresh graph"
          onPress={() => {
            void queryClient.invalidateQueries({ queryKey: ["git-graph"] });
          }}
          style={styles.action}
        >
          <Text style={styles.actionText}>{logQuery.isFetching ? "…" : "Refresh"}</Text>
        </Pressable>
      </View>

      {error ? (
        <Text style={[styles.danger, { padding: 14 }]}>{(error as Error).message}</Text>
      ) : null}

      {notice ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss message"
          onPress={() => setNotice(null)}
          style={{ paddingHorizontal: 14, paddingVertical: 6 }}
        >
          <Text numberOfLines={2} style={styles.muted}>
            {notice} (tap to dismiss)
          </Text>
        </Pressable>
      ) : null}

      {!error && repos.length === 0 && !reposQuery.isPending ? (
        <Text style={[styles.muted, { padding: 14 }]}>
          This workspace directory is not inside a git repository.
        </Text>
      ) : null}

      <FlatList
        ref={listRef}
        data={items}
        keyExtractor={(item) => `${item.kind}:${item.commit.hash}`}
        getItemLayout={(_, index) => ({
          length: items[index]?.kind === "detail" ? expandedHeight : height,
          offset: offsets[index] ?? 0,
          index,
        })}
        initialNumToRender={40}
        windowSize={11}
        removeClippedSubviews={false}
        stickyHeaderIndices={[0]}
        ListHeaderComponent={
          // Inside the list, so it shares the scroll container's width: outside it, a visible
          // scrollbar made every column heading sit ten pixels right of its values.
          <ColumnHeaderRow theme={theme} compact={compact} laneCount={graph.laneCount} />
        }
        renderItem={({ item }) => {
          if (item.kind === "detail") {
            return repoPath ? (
              <DetailPane
                theme={theme}
                compact={compact}
                root={directory}
                repoPath={repoPath}
                commit={item.commit}
                onClose={() => setSelectedHash(null)}
                onSelectCommit={selectCommit}
              />
            ) : null;
          }
          const row = graph.rows[item.index];
          if (!row) return null;
          return (
            <CommitRow
              commit={item.commit}
              row={row}
              laneCount={graph.laneCount}
              palette={palette}
              theme={theme}
              compact={compact}
              selected={item.commit.hash === selectedHash}
              matched={matchedHashes.has(item.commit.hash)}
              onPress={(hash) => setSelectedHash((current) => (current === hash ? null : hash))}
              onMenu={openMenu}
              onRefActivate={activateRef}
              onRefMenu={(ref) =>
                toLocal(ref.x, ref.y, (x, y) => setRefMenu({ ...ref, x, y }))
              }
            />
          );
        }}
        ListEmptyComponent={
          logQuery.isPending ? (
            <Text style={[styles.muted, { padding: 14 }]}>Reading history…</Text>
          ) : null
        }
        ListFooterComponent={
          logQuery.data?.moreAvailable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Load more commits"
              onPress={() => setLimit((current) => current + DEFAULT_PAGE_SIZE)}
              style={{ padding: 12, alignItems: "center" }}
            >
              <Text style={styles.muted}>
                {logQuery.isFetching ? "Loading…" : `Load ${DEFAULT_PAGE_SIZE} more`}
              </Text>
            </Pressable>
          ) : null
        }
      />

      {refMenu ? (
        <RefMenu
          theme={theme}
          target={refMenu}
          width={size.width}
          height={size.height}
          onPick={(action) => {
            setRefMenu(null);
            if (action === "checkout-branch") {
              activateRef({ ...refMenu, isHead: false });
              return;
            }
            setRefPending({ target: refMenu, action });
          }}
          onCopy={() => {
            const name = refMenu.name;
            setRefMenu(null);
            void copyText(name).then((copied) =>
              setNotice(copied ? `Copied ${name}.` : "Clipboard unavailable."),
            );
          }}
          onClose={() => setRefMenu(null)}
        />
      ) : null}

      {refPending && repoPath ? (
        <RefDialog
          theme={theme}
          root={directory}
          repoPath={repoPath}
          target={refPending.target}
          action={refPending.action}
          branches={branchesQuery.data?.branches ?? []}
          remotes={branchesQuery.data?.remotes ?? []}
          onCancel={() => setRefPending(null)}
          onDone={(output) => {
            setRefPending(null);
            finishAction(output);
          }}
        />
      ) : null}

      {picker === "repo" ? (
        <Picker
          theme={theme}
          options={repoOptions}
          selected={repoPath ?? ""}
          onSelect={selectRepo}
          anchor={repoAnchor}
          width={compact ? 260 : 320}
        />
      ) : null}

      {menu ? (
        <CommitMenu
          theme={theme}
          target={menu}
          width={size.width}
          height={size.height}
          onPick={(action) => pickMenuAction(menu.commit, action)}
          onClose={() => setMenu(null)}
        />
      ) : null}

      {pending && repoPath && pending.action !== "copy-hash" && pending.action !== "copy-subject" ? (
        <ActionDialog
          theme={theme}
          root={directory}
          repoPath={repoPath}
          commit={pending.commit}
          action={pending.action}
          onCancel={() => setPending(null)}
          onDone={(output) => {
            setPending(null);
            finishAction(output);
          }}
        />
      ) : null}

      {picker === "branch" ? (
        <Picker
          theme={theme}
          options={branchOptions}
          selected={branch ?? ALL_BRANCHES}
          onSelect={(key) => {
            setBranch(key === ALL_BRANCHES ? null : key);
            setSelectedHash(null);
            setLimit(DEFAULT_PAGE_SIZE);
            setPicker(null);
          }}
          anchor={branchAnchor}
          width={300}
        />
      ) : null}
    </View>
  );
}
