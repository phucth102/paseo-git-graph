import React, { useMemo, useRef, useState } from "react";
import { Platform, Pressable, Text, View, type ViewStyle } from "react-native";
import type { PluginTheme } from "@getpaseo/plugin";
import { WORKING_TREE_ID, type Commit, type Ref } from "./graph.shared";
import type { GraphRow, GraphSegment } from "./layout.client";
import { laneColor, withAlpha } from "./colors.client";

export const LANE_WIDTH = 14;
export const LINE_WIDTH = 2;
export const DOT_SIZE = 9;
export const MAX_DRAWN_LANES = 14;
/** Left padding before the first lane, so dots are not glued to the panel edge. */
const GRAPH_PAD = 10;
/** The graph column never shrinks below this, or the "Graph" heading wraps onto two lines. */
const MIN_GRAPH_WIDTH = { compact: 52, regular: 86 } as const;

/** "monospace" is not a real family on iOS, so the hash column would fall back to the body font. */
export const MONOSPACE = Platform.select({ ios: "Menlo", macos: "Menlo", default: "monospace" });

/** Column widths shared by the header row and every commit row, in Git Graph's order. */
export const COLUMN_WIDTH = { menu: 22, date: 150, author: 128, commit: 68 } as const;

export function rowHeight(compact: boolean): number {
  return compact ? 30 : 26;
}

export function graphWidth(laneCount: number, compact: boolean): number {
  const lanes = Math.min(laneCount, MAX_DRAWN_LANES) * LANE_WIDTH + GRAPH_PAD * 2;
  return Math.max(compact ? MIN_GRAPH_WIDTH.compact : MIN_GRAPH_WIDTH.regular, lanes);
}

function laneCenter(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2 + GRAPH_PAD;
}

/**
 * One segment of the graph, drawn with plain views: a straight run is a thin rectangle, and a
 * lane change is a box with two adjacent borders and a rounded corner between them. Plugin client
 * bundles cannot import an SVG library, so an elbow with a radius is the closest thing to a curve.
 */
function segmentStyle(segment: GraphSegment, height: number, color: string): ViewStyle | null {
  const half = height / 2;
  const from = laneCenter(segment.from);
  const to = laneCenter(segment.to);
  const base: ViewStyle = { position: "absolute", borderColor: color };

  if (segment.kind === "through") {
    return {
      ...base,
      left: from - LINE_WIDTH / 2,
      top: 0,
      height,
      width: LINE_WIDTH,
      backgroundColor: color,
    };
  }

  if (segment.from === segment.to) {
    // Straight stub into or out of the dot.
    return {
      ...base,
      left: from - LINE_WIDTH / 2,
      top: segment.kind === "in" ? 0 : half,
      height: half,
      width: LINE_WIDTH,
      backgroundColor: color,
    };
  }

  const left = Math.min(from, to);
  const width = Math.abs(to - from);
  const radius = Math.min(width, half);

  if (segment.kind === "in") {
    // Comes down its own lane in the top half, then turns into the dot.
    const fromIsRight = from > to;
    return {
      ...base,
      left,
      top: 0,
      width,
      height: half,
      borderBottomWidth: LINE_WIDTH,
      ...(fromIsRight
        ? { borderRightWidth: LINE_WIDTH, borderBottomRightRadius: radius }
        : { borderLeftWidth: LINE_WIDTH, borderBottomLeftRadius: radius }),
    };
  }

  // "out": leaves the dot in the bottom half, then drops down the target lane.
  const toIsRight = to > from;
  return {
    ...base,
    left,
    top: half,
    width,
    height: half,
    borderTopWidth: LINE_WIDTH,
    ...(toIsRight
      ? { borderRightWidth: LINE_WIDTH, borderTopRightRadius: radius }
      : { borderLeftWidth: LINE_WIDTH, borderTopLeftRadius: radius }),
  };
}

export interface RefGroup {
  key: string;
  label: string;
  /** Remotes carrying the same branch, shown as extra segments inside one pill. */
  remotes: string[];
  type: Ref["type"];
  isHead: boolean;
}

/**
 * Git Graph shows `main` and `origin/main` as a single pill with the remote appended, and keeps
 * anything without a matching local branch — `origin/HEAD`, tags, the stash — on its own.
 */
export function groupRefs(refs: readonly Ref[]): RefGroup[] {
  const groups: RefGroup[] = [];
  const byLabel = new Map<string, RefGroup>();
  const locals = new Set(
    refs.filter((ref) => ref.type === "branch" || ref.type === "head").map((ref) => ref.name),
  );

  for (const ref of refs) {
    if (ref.type === "branch" || ref.type === "head") {
      const existing = byLabel.get(ref.name);
      if (existing) {
        existing.isHead = existing.isHead || ref.type === "head";
        continue;
      }
      const group: RefGroup = {
        key: `branch:${ref.name}`,
        label: ref.name,
        remotes: [],
        type: "branch",
        isHead: ref.type === "head",
      };
      byLabel.set(ref.name, group);
      groups.push(group);
      continue;
    }

    if (ref.type === "remote") {
      const separator = ref.name.indexOf("/");
      const remote = separator === -1 ? "" : ref.name.slice(0, separator);
      const base = separator === -1 ? ref.name : ref.name.slice(separator + 1);
      const owner = locals.has(base) ? byLabel.get(base) : undefined;
      if (owner && remote) {
        if (!owner.remotes.includes(remote)) owner.remotes.push(remote);
        continue;
      }
      groups.push({
        key: `remote:${ref.name}`,
        label: ref.name,
        remotes: [],
        type: "remote",
        isHead: false,
      });
      continue;
    }

    groups.push({
      key: `${ref.type}:${ref.name}`,
      label: ref.name,
      remotes: [],
      type: ref.type,
      isHead: false,
    });
  }

  return groups;
}

const REF_GLYPH: Record<Ref["type"], string> = {
  head: "⎇",
  branch: "⎇",
  remote: "⎇",
  tag: "⌗",
  stash: "≡",
};

const DOUBLE_PRESS_MS = 400;

export interface RefPress {
  name: string;
  kind: "branch" | "remote" | "tag";
  isHead: boolean;
  x: number;
  y: number;
}

/**
 * Git Graph opens a ref's menu on right click and checks it out on double click. React Native has
 * no double-press event, so two presses inside `DOUBLE_PRESS_MS` count as one.
 */
function useRefGestures(
  press: RefPress,
  onActivate: (ref: RefPress) => void,
  onMenu: (ref: RefPress) => void,
) {
  const lastPress = useRef(0);
  const handlePress = (x: number, y: number) => {
    const now = performance.now();
    const doublePressed = now - lastPress.current < DOUBLE_PRESS_MS;
    lastPress.current = doublePressed ? 0 : now;
    if (doublePressed) onActivate({ ...press, x, y });
  };
  const contextMenuProps = {
    onContextMenu: (event: { preventDefault?: () => void; stopPropagation?: () => void; clientX?: number; clientY?: number }) => {
      event.preventDefault?.();
      event.stopPropagation?.();
      onMenu({ ...press, x: event.clientX ?? 0, y: event.clientY ?? 0 });
    },
  } as object;
  return { handlePress, contextMenuProps };
}

function RefBadge({
  group,
  theme,
  onActivate,
  onMenu,
}: {
  group: RefGroup;
  theme: PluginTheme;
  onActivate: (ref: RefPress) => void;
  onMenu: (ref: RefPress) => void;
}) {
  const accent = group.isHead;
  const border = accent
    ? theme.colors.accent
    : withAlpha(theme.colors.foregroundMuted, "88", theme.colors.foregroundMuted);
  const text = accent ? theme.colors.accentForeground : theme.colors.foreground;
  const isBranch = group.type === "branch" || group.type === "head";
  const own = useRefGestures(
    {
      name: group.label,
      kind: isBranch ? "branch" : group.type === "remote" ? "remote" : "tag",
      isHead: group.isHead,
      x: 0,
      y: 0,
    },
    onActivate,
    onMenu,
  );

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        paddingHorizontal: 5,
        paddingVertical: 1,
        borderRadius: 4,
        borderWidth: 1,
        borderColor: border,
        backgroundColor: accent ? theme.colors.accent : "transparent",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Ref ${group.label}`}
        onPress={(event) => own.handlePress(event.nativeEvent.pageX, event.nativeEvent.pageY)}
        onLongPress={(event) =>
          onMenu({
            name: group.label,
            kind: isBranch ? "branch" : group.type === "remote" ? "remote" : "tag",
            isHead: group.isHead,
            x: event.nativeEvent.pageX,
            y: event.nativeEvent.pageY,
          })
        }
        {...own.contextMenuProps}
        style={{ flexDirection: "row", alignItems: "center" }}
      >
        <Text style={{ fontSize: 9, lineHeight: 14, color: text, marginRight: 3 }}>
          {REF_GLYPH[group.type]}
        </Text>
        <Text numberOfLines={1} style={{ fontSize: 10, lineHeight: 14, color: text }}>
          {group.label}
        </Text>
      </Pressable>
      {group.remotes.map((remote) => (
        <RemoteSegment
          key={remote}
          remote={remote}
          branch={group.label}
          accent={accent}
          textColor={text}
          border={border}
          theme={theme}
          onActivate={onActivate}
          onMenu={onMenu}
        />
      ))}
    </View>
  );
}

/** The `| origin` half of a combined pill: its own ref, so it gets its own gestures. */
function RemoteSegment({
  remote,
  branch,
  accent,
  textColor,
  border,
  theme,
  onActivate,
  onMenu,
}: {
  remote: string;
  branch: string;
  accent: boolean;
  textColor: string;
  border: string;
  theme: PluginTheme;
  onActivate: (ref: RefPress) => void;
  onMenu: (ref: RefPress) => void;
}) {
  const press: RefPress = { name: `${remote}/${branch}`, kind: "remote", isHead: false, x: 0, y: 0 };
  const gestures = useRefGestures(press, onActivate, onMenu);
  return (
    <View style={{ flexDirection: "row", alignItems: "center" }}>
      <View
        style={{ width: 1, height: 11, marginHorizontal: 4, backgroundColor: accent ? textColor : border }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Ref ${press.name}`}
        onPress={(event) => gestures.handlePress(event.nativeEvent.pageX, event.nativeEvent.pageY)}
        onLongPress={(event) => onMenu({ ...press, x: event.nativeEvent.pageX, y: event.nativeEvent.pageY })}
        {...gestures.contextMenuProps}
      >
        <Text
          numberOfLines={1}
          style={{
            fontSize: 10,
            lineHeight: 14,
            color: accent ? textColor : theme.colors.foregroundMuted,
          }}
        >
          {remote}
        </Text>
      </Pressable>
    </View>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Git Graph's date column: `20 Aug 2026 15:58`. */
export function formatDate(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function ColumnHeaderRow({
  theme,
  compact,
  laneCount,
}: {
  theme: PluginTheme;
  compact: boolean;
  laneCount: number;
}) {
  const label = {
    fontSize: 11,
    color: theme.colors.foregroundMuted,
    textTransform: "uppercase" as const,
    letterSpacing: 0.4,
  };
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        height: 24,
        paddingRight: 10,
        // Opaque: it is sticky, so scrolled rows pass underneath it.
        backgroundColor: theme.colors.surface0,
        borderBottomWidth: 1,
        borderBottomColor: withAlpha(theme.colors.foregroundMuted, "22"),
      }}
    >
      <Text numberOfLines={1} style={[label, { width: graphWidth(laneCount, compact), paddingLeft: GRAPH_PAD }]}>
        Graph
      </Text>
      <Text numberOfLines={1} style={[label, { flex: 1 }]}>
        Description
      </Text>
      <View style={{ width: COLUMN_WIDTH.menu }} />
      {compact ? null : (
        <>
          <Text style={[label, { width: COLUMN_WIDTH.date, marginLeft: 10 }]}>Date</Text>
          <Text style={[label, { width: COLUMN_WIDTH.author, marginLeft: 6 }]}>Author</Text>
          <Text style={[label, { width: COLUMN_WIDTH.commit, marginLeft: 6 }]}>Commit</Text>
        </>
      )}
    </View>
  );
}

export interface CommitRowProps {
  commit: Commit;
  row: GraphRow;
  laneCount: number;
  palette: string[];
  theme: PluginTheme;
  compact: boolean;
  selected: boolean;
  /** True while a search is running and this commit is one of the hits. */
  matched?: boolean;
  onPress: (hash: string) => void;
  onMenu: (commit: Commit, x: number, y: number) => void;
  onRefActivate: (ref: RefPress) => void;
  onRefMenu: (ref: RefPress) => void;
}

export function CommitRow({
  commit,
  row,
  laneCount,
  palette,
  theme,
  compact,
  selected,
  matched = false,
  onPress,
  onMenu,
  onRefActivate,
  onRefMenu,
}: CommitRowProps) {
  const height = rowHeight(compact);
  const [hovered, setHovered] = useState(false);
  const dotColor = laneColor(palette, row.colorIndex);
  // The working-tree row is drawn hollow, like an unfinished commit.
  const isWorkingTree = commit.hash === WORKING_TREE_ID;
  const hollow = row.isMerge || isWorkingTree;
  const segments = useMemo(
    () =>
      row.segments
        .filter((segment) => segment.from < MAX_DRAWN_LANES && segment.to < MAX_DRAWN_LANES)
        .map((segment) => ({
          key: `${segment.kind}-${segment.from}-${segment.to}-${segment.colorIndex}`,
          style: segmentStyle(segment, height, laneColor(palette, segment.colorIndex)),
        })),
    [row.segments, height, palette],
  );
  const groups = useMemo(() => groupRefs(commit.refs), [commit.refs]);
  const visibleGroups = groups.slice(0, compact ? 1 : 3);
  const hiddenGroups = groups.length - visibleGroups.length;

  const background = selected
    ? withAlpha(theme.colors.accent, "33")
    : matched
      ? withAlpha(theme.colors.accent, "1f")
      : hovered
        ? withAlpha(theme.colors.foregroundMuted, "1a")
        : "transparent";

  // React Native Web forwards this straight to the DOM node; on native it is simply ignored, and
  // long press covers the same ground there.
  const contextMenuProps = {
    onContextMenu: (event: { preventDefault?: () => void; clientX?: number; clientY?: number }) => {
      if (isWorkingTree) return;
      event.preventDefault?.();
      onMenu(commit, event.clientX ?? 0, event.clientY ?? 0);
    },
  } as object;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Commit ${commit.hash.slice(0, 7)}: ${commit.subject}`}
      onPress={() => onPress(commit.hash)}
      onLongPress={(event) => {
        if (isWorkingTree) return;
        onMenu(commit, event.nativeEvent.pageX, event.nativeEvent.pageY);
      }}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      {...contextMenuProps}
      style={{
        height,
        flexDirection: "row",
        alignItems: "center",
        paddingRight: 10,
        backgroundColor: background,
      }}
    >
      <View style={{ width: graphWidth(laneCount, compact), height, position: "relative" }}>
        {segments.map((segment) =>
          segment.style ? <View key={segment.key} style={segment.style} /> : null,
        )}
        {row.lane < MAX_DRAWN_LANES ? (
          <View
            style={{
              position: "absolute",
              left: laneCenter(row.lane) - DOT_SIZE / 2,
              top: height / 2 - DOT_SIZE / 2,
              width: DOT_SIZE,
              height: DOT_SIZE,
              borderRadius: DOT_SIZE / 2,
              backgroundColor: hollow ? theme.colors.surface0 : dotColor,
              borderWidth: hollow ? LINE_WIDTH : 0,
              borderColor: dotColor,
            }}
          />
        ) : null}
      </View>

      {visibleGroups.length > 0 ? (
        <View
          style={{ flexDirection: "row", gap: 4, marginRight: 6, maxWidth: compact ? 110 : 300 }}
        >
          {visibleGroups.map((group) => (
            <RefBadge
              key={group.key}
              group={group}
              theme={theme}
              onActivate={onRefActivate}
              onMenu={onRefMenu}
            />
          ))}
          {hiddenGroups > 0 ? (
            <Text style={{ fontSize: 10, lineHeight: 14, color: theme.colors.foregroundMuted }}>
              +{hiddenGroups}
            </Text>
          ) : null}
        </View>
      ) : null}

      <Text
        numberOfLines={1}
        style={{
          flex: 1,
          fontSize: compact ? 12 : 13,
          color: theme.colors.foreground,
          fontWeight: isWorkingTree ? "600" : "400",
        }}
      >
        {commit.subject}
      </Text>

      {isWorkingTree ? (
        <View style={{ width: COLUMN_WIDTH.menu }} />
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Actions for ${commit.hash.slice(0, 7)}`}
          onPress={(event) => onMenu(commit, event.nativeEvent.pageX, event.nativeEvent.pageY)}
          style={{ width: COLUMN_WIDTH.menu, alignItems: "center", opacity: hovered || selected ? 1 : 0 }}
        >
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>⋯</Text>
        </Pressable>
      )}

      {compact ? null : (
        <>
          <Text
            numberOfLines={1}
            style={{
              width: COLUMN_WIDTH.date,
              fontSize: 12,
              color: theme.colors.foregroundMuted,
              marginLeft: 10,
            }}
          >
            {isWorkingTree ? "*" : formatDate(commit.date)}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              width: COLUMN_WIDTH.author,
              fontSize: 12,
              color: theme.colors.foregroundMuted,
              marginLeft: 6,
            }}
          >
            {isWorkingTree ? "*" : commit.author}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              width: COLUMN_WIDTH.commit,
              fontSize: 12,
              color: theme.colors.foregroundMuted,
              marginLeft: 6,
              fontFamily: MONOSPACE,
            }}
          >
            {isWorkingTree ? "*" : commit.hash.slice(0, 7)}
          </Text>
        </>
      )}
    </Pressable>
  );
}
