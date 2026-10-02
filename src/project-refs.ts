import { ProjectRef } from './types.js';

/**
 * Parses project references of the form "owner/number" (or "owner#number").
 * Throws on malformed entries so a typo doesn't silently drop a project.
 */
export function parseProjectRefs(entries: string[]): ProjectRef[] {
  const refs: ProjectRef[] = [];
  for (const entry of entries) {
    const m = /^([A-Za-z0-9][A-Za-z0-9-]*)[/#](\d+)$/.exec(entry.trim());
    if (!m) {
      throw new Error(`Invalid project "${entry}". Expected "owner/number", e.g. "my-org/16".`);
    }
    refs.push({ owner: m[1], number: parseInt(m[2], 10) });
  }
  return refs;
}

/** Removes duplicate references (same owner, case-insensitive, and number). */
export function uniqueProjectRefs(refs: ProjectRef[]): ProjectRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => {
    const key = `${r.owner.toLowerCase()}/${r.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
