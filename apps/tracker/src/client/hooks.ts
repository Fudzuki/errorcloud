import { useQuery } from "@tanstack/react-query";
import type { Project } from "../shared/types";
import { api } from "./api";

export function useProjects() {
  return useQuery({ queryKey: ["projects"], queryFn: () => api<Project[]>("/projects") });
}

export function useProject(id: string | undefined) {
  const projects = useProjects();
  return { ...projects, data: projects.data?.find((p) => p.id === id) };
}
