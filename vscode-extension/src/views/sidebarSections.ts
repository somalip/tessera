export const sidebarSections = [
  { id: "routing", label: "Current editor" },
  { id: "editor", label: "Code actions" },
  { id: "models", label: "Installed models" },
  { id: "usage", label: "Session usage" },
  { id: "tools", label: "Tools" },
  { id: "resources", label: "System resources" },
] as const;

export type SidebarSection = typeof sidebarSections[number]["id"];

export function visibleSections(advanced: boolean, selected?: readonly SidebarSection[]): readonly SidebarSection[] {
  return selected ?? (advanced ? sidebarSections : sidebarSections.slice(0, 4)).map(section => section.id);
}
