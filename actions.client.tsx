import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useMutation } from "@tanstack/react-query";
import { type PluginTheme, useRpc } from "@getpaseo/plugin";
import {
  RESET_MODES,
  actionRpc,
  refActionRpc,
  type Commit,
  type RefActionKind,
} from "./graph.shared";
import { withAlpha } from "./colors.client";
import { MONOSPACE } from "./graph-row.client";

export type MenuAction =
  | "checkout"
  | "create-branch"
  | "create-tag"
  | "cherry-pick"
  | "revert"
  | "merge"
  | "reset"
  | "copy-hash"
  | "copy-subject";

export interface MenuTarget {
  commit: Commit;
  x: number;
  y: number;
}

const MENU_ITEMS: Array<{ action: MenuAction; label: string; destructive?: boolean }> = [
  { action: "checkout", label: "Checkout…" },
  { action: "create-branch", label: "Create Branch…" },
  { action: "create-tag", label: "Create Tag…" },
  { action: "cherry-pick", label: "Cherry Pick…" },
  { action: "revert", label: "Revert…" },
  { action: "merge", label: "Merge into current branch…" },
  { action: "reset", label: "Reset current branch to this commit…", destructive: true },
  { action: "copy-hash", label: "Copy Commit Hash" },
  { action: "copy-subject", label: "Copy Commit Subject" },
];

const MENU_WIDTH = 268;
const MENU_HEIGHT = 300;

/**
 * Writes to the system clipboard. The async API is preferred, but it is permission-gated and
 * refuses in some webviews, so a hidden selection plus `execCommand` is kept as the fallback.
 */
export async function copyText(text: string): Promise<boolean> {
  const view = globalThis as {
    navigator?: { clipboard?: { writeText?: (value: string) => Promise<void> } };
    document?: Document;
  };
  const clipboard = view.navigator?.clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to the legacy path.
    }
  }

  const documentRef = view.document;
  if (!documentRef?.body) return false;
  try {
    const field = documentRef.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.position = "fixed";
    field.style.opacity = "0";
    documentRef.body.appendChild(field);
    field.select();
    const copied = documentRef.execCommand("copy");
    documentRef.body.removeChild(field);
    return copied;
  } catch {
    return false;
  }
}

export function CommitMenu({
  theme,
  target,
  width,
  height,
  onPick,
  onClose,
}: {
  theme: PluginTheme;
  target: MenuTarget;
  width: number;
  height: number;
  onPick: (action: MenuAction) => void;
  onClose: () => void;
}) {
  // Keep the menu inside the panel when the click lands near an edge.
  const left = Math.max(8, Math.min(target.x, Math.max(8, width - MENU_WIDTH - 8)));
  const top = Math.max(8, Math.min(target.y, Math.max(8, height - MENU_HEIGHT - 8)));

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss the commit menu"
        onPress={onClose}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          position: "absolute",
          top,
          left,
          width: MENU_WIDTH,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
          backgroundColor: theme.colors.surface0,
          paddingVertical: 4,
          zIndex: 20,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            paddingHorizontal: 12,
            paddingVertical: 6,
            fontFamily: MONOSPACE,
          }}
        >
          {target.commit.hash.slice(0, 8)}
        </Text>
        {MENU_ITEMS.map((item) => (
          <Pressable
            key={item.action}
            accessibilityRole="button"
            accessibilityLabel={item.label}
            onPress={() => onPick(item.action)}
            style={{ paddingHorizontal: 12, paddingVertical: 6 }}
          >
            <Text
              style={{
                fontSize: 12,
                color: item.destructive ? theme.colors.statusDanger : theme.colors.foreground,
              }}
            >
              {item.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </>
  );
}

type WriteAction = Exclude<MenuAction, "copy-hash" | "copy-subject">;

const ACTION_COPY: Record<WriteAction, { title: string; description: string; confirm: string }> = {
  checkout: {
    title: "Checkout commit",
    description: "Moves HEAD to this commit. The branch you are on stays where it is, so HEAD ends up detached.",
    confirm: "Checkout",
  },
  "create-branch": {
    title: "Create branch",
    description: "Creates a branch pointing at this commit.",
    confirm: "Create branch",
  },
  "create-tag": {
    title: "Create tag",
    description: "Creates a tag at this commit. With a message it is annotated, without one it is lightweight.",
    confirm: "Create tag",
  },
  "cherry-pick": {
    title: "Cherry pick",
    description: "Applies this commit on top of the current branch. Conflicts stop the operation and are reported.",
    confirm: "Cherry pick",
  },
  revert: {
    title: "Revert",
    description: "Commits the inverse of this commit on the current branch.",
    confirm: "Revert",
  },
  merge: {
    title: "Merge into current branch",
    description: "Merges this commit into the branch you are on.",
    confirm: "Merge",
  },
  reset: {
    title: "Reset current branch",
    description:
      "Moves the current branch to this commit. Hard also discards every uncommitted change in the working tree — that cannot be undone.",
    confirm: "Reset",
  },
};

export function ActionDialog({
  theme,
  root,
  repoPath,
  commit,
  action,
  onCancel,
  onDone,
}: {
  theme: PluginTheme;
  root: string;
  repoPath: string;
  commit: Commit;
  action: WriteAction;
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const callAction = useRpc(actionRpc);
  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [checkoutAfterCreate, setCheckoutAfterCreate] = useState(action === "create-branch");
  const [resetMode, setResetMode] = useState<(typeof RESET_MODES)[number]>("mixed");
  const [noFastForward, setNoFastForward] = useState(true);

  const mutation = useMutation({
    mutationFn: () =>
      callAction({
        root,
        repoPath,
        kind: action,
        hash: commit.hash,
        name: name.trim() || undefined,
        message: message.trim() || undefined,
        checkoutAfterCreate,
        resetMode,
        noFastForward,
      }),
    onSuccess: (result) => onDone(result.output),
  });

  const copy = ACTION_COPY[action];
  const needsName = action === "create-branch" || action === "create-tag";
  const styles = useMemo(
    () => ({
      backdrop: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        // Fixed rather than theme-derived: the dialog has to read as modal on every theme.
        backgroundColor: "rgba(0, 0, 0, 0.45)",
        zIndex: 30,
      },
      card: {
        width: 420,
        maxWidth: "92%" as const,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
        backgroundColor: theme.colors.surface0,
        padding: 16,
        gap: 10,
      },
      title: { color: theme.colors.foreground, fontSize: 15 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      input: {
        color: theme.colors.foreground,
        fontSize: 13,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
      },
      primary: {
        paddingHorizontal: 14,
        paddingVertical: 8,
        borderRadius: 8,
        backgroundColor: theme.colors.accent,
      },
      primaryText: { color: theme.colors.accentForeground, fontSize: 13 },
      secondary: { paddingHorizontal: 14, paddingVertical: 8 },
      toggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    }),
    [theme],
  );

  return (
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.title}>{copy.title}</Text>
        <Text numberOfLines={2} style={styles.muted}>
          {commit.hash.slice(0, 8)} · {commit.subject}
        </Text>
        <Text style={action === "reset" ? styles.danger : styles.muted}>{copy.description}</Text>

        {needsName ? (
          <TextInput
            accessibilityLabel={action === "create-branch" ? "Branch name" : "Tag name"}
            placeholder={action === "create-branch" ? "feature/my-branch" : "v1.2.3"}
            placeholderTextColor={theme.colors.foregroundMuted}
            autoFocus
            value={name}
            onChangeText={setName}
            style={styles.input}
          />
        ) : null}

        {action === "create-tag" ? (
          <TextInput
            accessibilityLabel="Tag message"
            placeholder="Message (optional, makes it annotated)"
            placeholderTextColor={theme.colors.foregroundMuted}
            value={message}
            onChangeText={setMessage}
            style={styles.input}
          />
        ) : null}

        {action === "create-branch" ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: checkoutAfterCreate }}
            accessibilityLabel="Check out after creating"
            onPress={() => setCheckoutAfterCreate((current) => !current)}
            style={styles.toggle}
          >
            <Text style={styles.muted}>{checkoutAfterCreate ? "☑" : "☐"}</Text>
            <Text style={styles.muted}>Check out after creating</Text>
          </Pressable>
        ) : null}

        {action === "merge" ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: noFastForward }}
            accessibilityLabel="Always create a merge commit"
            onPress={() => setNoFastForward((current) => !current)}
            style={styles.toggle}
          >
            <Text style={styles.muted}>{noFastForward ? "☑" : "☐"}</Text>
            <Text style={styles.muted}>Always create a merge commit (--no-ff)</Text>
          </Pressable>
        ) : null}

        {action === "reset" ? (
          <View style={{ flexDirection: "row", gap: 8 }}>
            {RESET_MODES.map((mode) => (
              <Pressable
                key={mode}
                accessibilityRole="radio"
                accessibilityState={{ selected: resetMode === mode }}
                accessibilityLabel={`${mode} reset`}
                onPress={() => setResetMode(mode)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor:
                    resetMode === mode
                      ? theme.colors.accent
                      : withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
                  backgroundColor:
                    resetMode === mode ? withAlpha(theme.colors.accent, "22") : "transparent",
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{mode}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {mutation.error ? (
          <ScrollView style={{ maxHeight: 120 }}>
            <Text style={[styles.danger, { fontFamily: MONOSPACE, fontSize: 11 }]}>
              {(mutation.error as Error).message}
            </Text>
          </ScrollView>
        ) : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onCancel}
            style={styles.secondary}
          >
            <Text style={styles.muted}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.confirm}
            disabled={mutation.isPending || (needsName && !name.trim())}
            onPress={() => mutation.mutate()}
            style={[
              styles.primary,
              {
                opacity: mutation.isPending || (needsName && !name.trim()) ? 0.6 : 1,
                backgroundColor: action === "reset" ? theme.colors.statusDanger : theme.colors.accent,
              },
            ]}
          >
            <Text style={styles.primaryText}>
              {mutation.isPending ? "Running…" : copy.confirm}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}


export type RefKind = "branch" | "remote" | "tag";

export interface RefTarget {
  name: string;
  kind: RefKind;
  isHead: boolean;
  x: number;
  y: number;
}

const REF_MENU_ITEMS: Record<RefKind, Array<{ action: RefActionKind; label: string; destructive?: boolean }>> = {
  branch: [
    { action: "checkout-branch", label: "Checkout Branch" },
    { action: "rename-branch", label: "Rename Branch…" },
    { action: "delete-branch", label: "Delete Branch…", destructive: true },
    { action: "merge-ref", label: "Merge into current branch…" },
    { action: "push-branch", label: "Push Branch…" },
  ],
  remote: [
    { action: "checkout-remote", label: "Checkout Branch…" },
    { action: "fetch-into-local", label: "Fetch into local branch…" },
    { action: "merge-ref", label: "Merge into current branch…" },
    { action: "pull-ref", label: "Pull into current branch…" },
    { action: "delete-remote-branch", label: "Delete Remote Branch…", destructive: true },
  ],
  tag: [
    { action: "push-tag", label: "Push Tag…" },
    { action: "delete-tag", label: "Delete Tag…", destructive: true },
  ],
};

const REF_MENU_WIDTH = 264;
const REF_MENU_HEIGHT = 220;

export function RefMenu({
  theme,
  target,
  width,
  height,
  onPick,
  onCopy,
  onClose,
}: {
  theme: PluginTheme;
  target: RefTarget;
  width: number;
  height: number;
  onPick: (action: RefActionKind) => void;
  onCopy: () => void;
  onClose: () => void;
}) {
  const left = Math.max(8, Math.min(target.x, Math.max(8, width - REF_MENU_WIDTH - 8)));
  const top = Math.max(8, Math.min(target.y, Math.max(8, height - REF_MENU_HEIGHT - 8)));
  const items = REF_MENU_ITEMS[target.kind];

  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Dismiss the ref menu"
        onPress={onClose}
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <View
        style={{
          position: "absolute",
          top,
          left,
          width: REF_MENU_WIDTH,
          borderRadius: 8,
          borderWidth: 1,
          borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
          backgroundColor: theme.colors.surface0,
          paddingVertical: 4,
          zIndex: 20,
        }}
      >
        <Text
          numberOfLines={1}
          style={{
            color: theme.colors.foregroundMuted,
            fontSize: 11,
            paddingHorizontal: 12,
            paddingVertical: 6,
          }}
        >
          {target.name}
        </Text>
        {items
          .filter((item) => !(target.isHead && item.action === "checkout-branch"))
          .map((item) => (
            <Pressable
              key={item.action}
              accessibilityRole="button"
              accessibilityLabel={item.label}
              onPress={() => onPick(item.action)}
              style={{ paddingHorizontal: 12, paddingVertical: 6 }}
            >
              <Text
                style={{
                  fontSize: 12,
                  color: item.destructive ? theme.colors.statusDanger : theme.colors.foreground,
                }}
              >
                {item.label}
              </Text>
            </Pressable>
          ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Copy Ref Name"
          onPress={onCopy}
          style={{ paddingHorizontal: 12, paddingVertical: 6 }}
        >
          <Text style={{ fontSize: 12, color: theme.colors.foreground }}>Copy Ref Name</Text>
        </Pressable>
      </View>
    </>
  );
}

interface RefActionCopy {
  title: string;
  description: string;
  confirm: string;
  nameLabel?: string;
  destructive?: boolean;
}

const REF_ACTION_COPY: Record<RefActionKind, RefActionCopy> = {
  "checkout-branch": {
    title: "Checkout branch",
    description: "Switches the working tree to this branch.",
    confirm: "Checkout",
  },
  "checkout-remote": {
    title: "Checkout remote branch",
    description: "Creates a local branch tracking this remote branch and switches to it.",
    confirm: "Checkout Branch",
    nameLabel: "New local branch",
  },
  "rename-branch": {
    title: "Rename branch",
    description: "Renames the branch. Any remote branch keeps its old name.",
    confirm: "Rename",
    nameLabel: "New name",
  },
  "delete-branch": {
    title: "Delete branch",
    description: "Deletes the local branch. Git refuses unless it is merged; force deletes it anyway.",
    confirm: "Delete",
    destructive: true,
  },
  "delete-remote-branch": {
    title: "Delete remote branch",
    description: "Deletes the branch on the remote. Everyone fetching that remote loses it too.",
    confirm: "Delete on remote",
    destructive: true,
  },
  "merge-ref": {
    title: "Merge into current branch",
    description: "Merges this ref into the branch you are on.",
    confirm: "Merge",
  },
  "pull-ref": {
    title: "Pull into current branch",
    description: "Fetches from the remote and merges the branch into the one you are on.",
    confirm: "Pull",
  },
  "fetch-into-local": {
    title: "Fetch into local branch",
    description: "Fetches the remote branch straight into a local branch, without checking it out.",
    confirm: "Fetch",
    nameLabel: "Local branch",
  },
  "push-branch": {
    title: "Push branch",
    description: "Publishes this branch to the remote.",
    confirm: "Push",
  },
  "push-tag": {
    title: "Push tag",
    description: "Publishes this tag to the remote.",
    confirm: "Push",
  },
  "delete-tag": {
    title: "Delete tag",
    description: "Deletes the tag locally. The remote keeps its copy.",
    confirm: "Delete",
    destructive: true,
  },
};

/** Strips the remote prefix so `origin/feature/x` prefills as `feature/x`. */
function suggestLocalName(ref: string, remotes: readonly string[]): string {
  for (const remote of remotes) {
    if (ref.startsWith(`${remote}/`)) return ref.slice(remote.length + 1);
  }
  return ref;
}

export function RefDialog({
  theme,
  root,
  repoPath,
  target,
  action,
  branches,
  remotes,
  onCancel,
  onDone,
}: {
  theme: PluginTheme;
  root: string;
  repoPath: string;
  target: RefTarget;
  action: RefActionKind;
  branches: readonly string[];
  remotes: readonly string[];
  onCancel: () => void;
  onDone: (message: string) => void;
}) {
  const callRefAction = useRpc(refActionRpc);
  const copy = REF_ACTION_COPY[action];
  const needsName = Boolean(copy.nameLabel);
  const needsRemote = action === "push-branch" || action === "push-tag";
  const [name, setName] = useState(
    needsName ? suggestLocalName(target.name, remotes) : "",
  );
  const [remote, setRemote] = useState(remotes[0] ?? "origin");
  const [force, setForce] = useState(false);
  const [setUpstream, setSetUpstream] = useState(action === "push-branch");
  const [noFastForward, setNoFastForward] = useState(true);

  const mutation = useMutation({
    mutationFn: (kind: RefActionKind) =>
      callRefAction({
        root,
        repoPath,
        kind,
        ref: target.name,
        newName: needsName ? name.trim() : undefined,
        remote: needsRemote ? remote : undefined,
        force,
        setUpstream,
        noFastForward,
      }),
    onSuccess: (result) => onDone(result.output),
  });

  const nameTaken = needsName && action !== "rename-branch" && branches.includes(name.trim());
  const styles = useMemo(
    () => ({
      backdrop: {
        position: "absolute" as const,
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        backgroundColor: "rgba(0, 0, 0, 0.45)",
        zIndex: 30,
      },
      card: {
        width: 420,
        maxWidth: "92%" as const,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
        backgroundColor: theme.colors.surface0,
        padding: 16,
        gap: 10,
      },
      title: { color: theme.colors.foreground, fontSize: 15 },
      muted: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 12 },
      input: {
        color: theme.colors.foreground,
        fontSize: 13,
        paddingHorizontal: 10,
        paddingVertical: 7,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
      },
      primaryText: { color: theme.colors.accentForeground, fontSize: 13 },
      toggle: { flexDirection: "row" as const, alignItems: "center" as const, gap: 8 },
    }),
    [theme],
  );

  return (
    <View style={styles.backdrop}>
      <View style={styles.card}>
        <Text style={styles.title}>{copy.title}</Text>
        <Text numberOfLines={1} style={styles.muted}>
          {target.name}
        </Text>
        <Text style={copy.destructive ? styles.danger : styles.muted}>{copy.description}</Text>

        {needsName ? (
          <TextInput
            accessibilityLabel={copy.nameLabel}
            placeholder={copy.nameLabel}
            placeholderTextColor={theme.colors.foregroundMuted}
            autoFocus
            value={name}
            onChangeText={setName}
            style={styles.input}
          />
        ) : null}

        {nameTaken ? (
          <Text style={styles.danger}>
            A branch named {name.trim()} already exists.
            {action === "checkout-remote" ? " Check out the existing one instead?" : ""}
          </Text>
        ) : null}

        {needsRemote ? (
          <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
            {remotes.map((candidate) => (
              <Pressable
                key={candidate}
                accessibilityRole="radio"
                accessibilityState={{ selected: remote === candidate }}
                accessibilityLabel={`Remote ${candidate}`}
                onPress={() => setRemote(candidate)}
                style={{
                  paddingHorizontal: 12,
                  paddingVertical: 6,
                  borderRadius: 8,
                  borderWidth: 1,
                  borderColor:
                    remote === candidate
                      ? theme.colors.accent
                      : withAlpha(theme.colors.foregroundMuted, "66", theme.colors.foregroundMuted),
                  backgroundColor:
                    remote === candidate ? withAlpha(theme.colors.accent, "22") : "transparent",
                }}
              >
                <Text style={{ color: theme.colors.foreground, fontSize: 12 }}>{candidate}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {action === "delete-branch" ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: force }}
            accessibilityLabel="Force delete"
            onPress={() => setForce((current) => !current)}
            style={styles.toggle}
          >
            <Text style={styles.muted}>{force ? "☑" : "☐"}</Text>
            <Text style={styles.muted}>Delete even if it is not merged (-D)</Text>
          </Pressable>
        ) : null}

        {action === "push-branch" ? (
          <>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: setUpstream }}
              accessibilityLabel="Set upstream"
              onPress={() => setSetUpstream((current) => !current)}
              style={styles.toggle}
            >
              <Text style={styles.muted}>{setUpstream ? "☑" : "☐"}</Text>
              <Text style={styles.muted}>Set as upstream (--set-upstream)</Text>
            </Pressable>
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: force }}
              accessibilityLabel="Force push"
              onPress={() => setForce((current) => !current)}
              style={styles.toggle}
            >
              <Text style={styles.muted}>{force ? "☑" : "☐"}</Text>
              <Text style={styles.danger}>Force push (--force-with-lease)</Text>
            </Pressable>
          </>
        ) : null}

        {action === "merge-ref" || action === "pull-ref" ? (
          <Pressable
            accessibilityRole="checkbox"
            accessibilityState={{ checked: noFastForward }}
            accessibilityLabel="Always create a merge commit"
            onPress={() => setNoFastForward((current) => !current)}
            style={styles.toggle}
          >
            <Text style={styles.muted}>{noFastForward ? "☑" : "☐"}</Text>
            <Text style={styles.muted}>Always create a merge commit (--no-ff)</Text>
          </Pressable>
        ) : null}

        {mutation.error ? (
          <ScrollView style={{ maxHeight: 120 }}>
            <Text style={[styles.danger, { fontFamily: MONOSPACE, fontSize: 11 }]}>
              {(mutation.error as Error).message}
            </Text>
          </ScrollView>
        ) : null}

        <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 6 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            onPress={onCancel}
            style={{ paddingHorizontal: 14, paddingVertical: 8 }}
          >
            <Text style={styles.muted}>Cancel</Text>
          </Pressable>
          {nameTaken && action === "checkout-remote" ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Checkout the existing branch"
              disabled={mutation.isPending}
              onPress={() => mutation.mutate("checkout-branch")}
              style={{ paddingHorizontal: 14, paddingVertical: 8 }}
            >
              <Text style={styles.muted}>Checkout existing</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copy.confirm}
            disabled={mutation.isPending || (needsName && (!name.trim() || nameTaken))}
            onPress={() => mutation.mutate(action)}
            style={{
              paddingHorizontal: 14,
              paddingVertical: 8,
              borderRadius: 8,
              backgroundColor: copy.destructive ? theme.colors.statusDanger : theme.colors.accent,
              opacity: mutation.isPending || (needsName && (!name.trim() || nameTaken)) ? 0.6 : 1,
            }}
          >
            <Text style={styles.primaryText}>
              {mutation.isPending ? "Running…" : copy.confirm}
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}
