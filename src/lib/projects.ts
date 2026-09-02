import type { Project } from "../types";

export type ProjectGroup = "working" | "stowed";

export function isStowed(project: Project): boolean {
  return Boolean(project.stowed);
}

export function workingProjects(projects: Project[]): Project[] {
  return projects.filter((project) => !isStowed(project));
}

export function stowedProjects(projects: Project[]): Project[] {
  return projects.filter((project) => isStowed(project));
}

export function nextWorkingId(projects: Project[], exceptId?: string | null): string | null {
  return workingProjects(projects).find((project) => project.id !== exceptId)?.id ?? null;
}

export function placeProject(
  projects: Project[],
  fromId: string,
  dest: ProjectGroup,
  toIndex: number,
): Project[] {
  const from = projects.find((project) => project.id === fromId);
  if (!from) return projects;
  const rest = projects.filter((project) => project.id !== fromId);
  const working = rest.filter((project) => !isStowed(project));
  const stowed = rest.filter((project) => isStowed(project));
  const moved: Project = { ...from, stowed: dest === "stowed" };
  if (dest === "working") {
    const index = Math.max(0, Math.min(toIndex, working.length));
    return [...working.slice(0, index), moved, ...working.slice(index), ...stowed];
  }
  const index = Math.max(0, Math.min(toIndex, stowed.length));
  return [...working, ...stowed.slice(0, index), moved, ...stowed.slice(index)];
}

export function placementUnchanged(before: Project[], after: Project[]): boolean {
  if (before.length !== after.length) return false;
  return before.every(
    (project, index) =>
      project.id === after[index]?.id && Boolean(project.stowed) === Boolean(after[index]?.stowed),
  );
}
