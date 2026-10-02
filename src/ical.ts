import { CalendarCard, ActionConfig } from './types.js';
import { formatIcsDate } from './dates.js';

/**
 * Escapes characters for iCalendar text fields according to RFC 5545:
 * Backslash, semicolon, comma, and newlines must be escaped.
 */
function escapeIcsText(text: string): string {
  if (!text) return '';
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Folds a single iCalendar line so that each line does not exceed 75 octets.
 * Folded lines begin with a single space.
 */
function foldLine(line: string): string {
  const maxLineLength = 75;
  if (Buffer.byteLength(line, 'utf8') <= maxLineLength) {
    return line;
  }

  const parts: string[] = [];
  let remaining = line;
  let isFirst = true;

  while (remaining.length > 0) {
    const limit = isFirst ? maxLineLength : maxLineLength - 1; // 1 byte for leading space
    
    // Find character split that fits in limit bytes
    // Start at limit length (since UTF-8 chars are >= 1 byte) to avoid quadratic string slicing
    let cutIndex = Math.min(remaining.length, limit);
    while (cutIndex > 0 && Buffer.byteLength(remaining.slice(0, cutIndex), 'utf8') > limit) {
      cutIndex--;
    }

    // Do not split a UTF-16 surrogate pair (such as emojis or extended Unicode)
    if (cutIndex > 0 && cutIndex < remaining.length) {
      const code = remaining.charCodeAt(cutIndex - 1);
      if (code >= 0xd800 && code <= 0xdbff) {
        cutIndex--;
      }
    }

    if (cutIndex === 0) {
      // Safety fallback: if a single character/surrogate pair exceeds the limit, take the full character
      const firstCode = remaining.charCodeAt(0);
      cutIndex = firstCode >= 0xd800 && firstCode <= 0xdbff ? 2 : 1;
    }

    const chunk = remaining.slice(0, cutIndex);
    parts.push(isFirst ? chunk : ` ${chunk}`);
    remaining = remaining.slice(cutIndex);
    isFirst = false;
  }

  return parts.join('\r\n');
}

/**
 * Generates an RFC 5545 compliant .ics string from an array of CalendarCards.
 */
export function generateIcs(
  cards: CalendarCard[],
  config: ActionConfig
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//GitHub Card to Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(config.calendarName)}`,
    `X-WR-CALDESC:${escapeIcsText(config.calendarDescription)}`,
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    'X-PUBLISHED-TTL:PT1H',
  ];

  for (const card of cards) {
    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${card.uid}`);
    lines.push(`DTSTAMP:${formatIcsDate(card.updatedAt ?? card.startDate, false)}`);

    if (card.isAllDay) {
      lines.push(`DTSTART;VALUE=DATE:${formatIcsDate(card.startDate, true)}`);
      lines.push(`DTEND;VALUE=DATE:${formatIcsDate(card.endDate, true)}`);
    } else {
      lines.push(`DTSTART:${formatIcsDate(card.startDate, false)}`);
      lines.push(`DTEND:${formatIcsDate(card.endDate, false)}`);
    }

    // Google Calendar hides STATUS:CANCELLED events, which would defeat `include-closed`,
    // so closed cards stay CONFIRMED and are marked in the title instead.
    const summary = card.status === 'closed' ? `✓ ${card.title}` : card.title;
    lines.push(`SUMMARY:${escapeIcsText(summary)}`);

    if (card.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(card.description)}`);
    }

    if (card.url) {
      lines.push(`URL:${card.url.replace(/[\r\n]+/g, '')}`);
    }

    if (card.labels && card.labels.length > 0) {
      // Escape each category item individually; separator commas must not be escaped in RFC 5545
      lines.push(`CATEGORIES:${card.labels.map(escapeIcsText).join(',')}`);
    }

    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');

  // Fold all lines and join with standard CRLF
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
