import type { ThreadInfo, Workspace } from "./types";

export interface ProjectGroup { project: Workspace; threads: ThreadInfo[] }

/** SEC-001-02：スレッドをプロジェクトごとに分ける。並びは渡された順のまま */
export function groupThreads(threads: ThreadInfo[], projects: Workspace[]): { groups: ProjectGroup[]; chats: ThreadInfo[] } {
  return {
    groups: projects.map((project) => ({ project, threads: threads.filter((t) => t.workspaceId === project.id) })),
    chats: threads.filter((t) => t.workspaceId === null),
  };
}
