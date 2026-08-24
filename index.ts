import type { PluginContext } from "@getpaseo/plugin";
import {
  actionRpc,
  branchesRpc,
  commitDetailRpc,
  fetchRpc,
  fileDiffRpc,
  logRpc,
  readPrefsRpc,
  refActionRpc,
  reposRpc,
  signatureRpc,
  workingTreeRpc,
  writePrefsRpc,
} from "./graph.shared";
import {
  fetchRemotes,
  runAction,
  listBranches,
  listRepos,
  readFileDiff,
  readCommitDetail,
  readLog,
  readPreferences,
  readSignature,
  readWorkingTree,
  runRefAction,
  writePreferences,
} from "./git.server";
import { GitGraphPanel } from "./panel.client";

export default function contribute(plugin: PluginContext) {
  plugin.handle(reposRpc, listRepos);
  plugin.handle(branchesRpc, listBranches);
  plugin.handle(logRpc, readLog);
  plugin.handle(commitDetailRpc, readCommitDetail);
  plugin.handle(signatureRpc, readSignature);
  plugin.handle(workingTreeRpc, readWorkingTree);
  plugin.handle(fileDiffRpc, readFileDiff);
  plugin.handle(fetchRpc, fetchRemotes);
  plugin.handle(actionRpc, runAction);
  plugin.handle(refActionRpc, runRefAction);
  plugin.handle(readPrefsRpc, readPreferences);
  plugin.handle(writePrefsRpc, writePreferences);

  plugin.addWorkspacePanel({
    id: "graph",
    title: "Git Graph",
    icon: "GitBranch",
    context: "workspace",
    Component: GitGraphPanel,
  });

  plugin.addCommandCenterItem({
    id: "open-graph",
    title: "Open Git Graph",
    icon: "GitBranch",
    keywords: ["git", "graph", "history", "commits", "branches"],
    context: "workspace",
    onSelect({ openPanel }) {
      openPanel("graph");
    },
  });

  return () => {};
}
