import { CalendarCard } from './types.js';

const isIssueUrl = (url: string) => /\/(?:issues|pull)\/\d+/i.test(url);

/**
 * De-duplicates cards by issue URL. Draft issues and cards without a unique
 * issue URL are keyed by their UID.
 *
 * When an issue appears in both the repo scan and a project board, the project
 * card wins (it carries project date fields) but keeps the issue card's UID, so
 * calendar clients see an update instead of a delete + create.
 */
export function mergeCards(cards: CalendarCard[]): CalendarCard[] {
  const cardMap = new Map<string, CalendarCard>();

  for (const card of cards) {
    const key = isIssueUrl(card.url) ? `url:${card.url.toLowerCase()}` : `uid:${card.uid}`;
    const existing = cardMap.get(key);
    if (!existing) {
      cardMap.set(key, card);
    } else if (card.source === 'project_v2' && existing.source === 'issue') {
      cardMap.set(key, { ...card, uid: existing.uid });
    }
  }

  return Array.from(cardMap.values());
}
