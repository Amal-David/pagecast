import type { CloudflareProject } from "@/lib/types";

export function cloudflareProjectValue(project: CloudflareProject) {
  return `${project.accountId || "default"}:${project.name}`;
}

export function cloudflareProjectLabel(project: CloudflareProject) {
  return project.accountName ? `${project.accountName} / ${project.name}` : project.name;
}

export function cloudflareProjectDomain(project: CloudflareProject) {
  try {
    return new URL(project.baseUrl).hostname;
  } catch {
    return project.baseUrl.replace(/^https?:\/\//, "");
  }
}

export function getCloudflareProjectSelection(
  projects: CloudflareProject[],
  projectName: string,
  accountId = ""
) {
  const selectedProject = projects.find((project) =>
    project.name === projectName &&
    (!accountId || !project.accountId || project.accountId === accountId)
  );
  const selectedProjectValue = selectedProject ? cloudflareProjectValue(selectedProject) : "";
  const displayedProjects = selectedProject
    ? [
        selectedProject,
        ...projects.filter((project) => cloudflareProjectValue(project) !== selectedProjectValue)
      ]
    : projects;

  return { selectedProject, selectedProjectValue, displayedProjects };
}
