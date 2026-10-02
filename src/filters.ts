/** Case-insensitive include/exclude label filter shared by the repo and project fetchers. */
export function passesLabelFilters(
  labels: string[],
  includeLabels: string[],
  excludeLabels: string[]
): boolean {
  const lower = new Set(labels.map((l) => l.toLowerCase()));
  if (excludeLabels.some((ex) => lower.has(ex.toLowerCase()))) return false;
  if (includeLabels.length > 0 && !includeLabels.some((inc) => lower.has(inc.toLowerCase()))) return false;
  return true;
}

/** Keeps cards assigned to at least one of the given logins (case-insensitive, leading @ ignored). No filter when the list is empty. */
export function passesAssigneeFilter(assignees: string[], includeAssignees: string[]): boolean {
  if (includeAssignees.length === 0) return true;
  const wanted = new Set(includeAssignees.map((a) => a.replace(/^@/, '').toLowerCase()));
  return assignees.some((a) => wanted.has(a.replace(/^@/, '').toLowerCase()));
}
