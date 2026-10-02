/**
 * Utilities for extracting and formatting dates from GitHub Issues, Project cards, and labels.
 */

export interface ParsedDates {
  startDate: Date;
  dueDate: Date;
  isAllDay: boolean;
}

/**
 * Completes a one-sided range (a lone start or due date becomes a single-day range) and
 * swaps reversed dates. Returns null when neither date is present.
 */
export function normalizeDateRange(
  start: Date | null | undefined,
  due: Date | null | undefined
): { startDate: Date; dueDate: Date } | null {
  if (!start && !due) return null;
  let startDate = new Date((start ?? due)!.getTime());
  let dueDate = new Date((due ?? start)!.getTime());
  if (startDate.getTime() > dueDate.getTime()) {
    [startDate, dueDate] = [dueDate, startDate];
  }
  return { startDate, dueDate };
}

/**
 * Attempts to parse an ISO date string (YYYY-MM-DD or full ISO 8601).
 */
export function parseDateString(dateStr: string): Date | null {
  if (!dateStr) return null;
  const trimmed = dateStr.trim();

  // Format: YYYY-MM-DD (extracts leading date even from ISO strings like YYYY-MM-DDT07:00:00Z)
  const datePart = trimmed.split('T')[0];
  const ymdMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(datePart);
  if (ymdMatch) {
    const year = parseInt(ymdMatch[1], 10);
    const month = parseInt(ymdMatch[2], 10) - 1;
    const day = parseInt(ymdMatch[3], 10);
    const d = new Date(Date.UTC(year, month, day, 0, 0, 0));
    return isNaN(d.getTime()) ? null : d;
  }

  // Full ISO format or standard date string fallback
  const d = new Date(trimmed);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Parses dates from an issue body using regex and labels.
 */
export function extractIssueDates(
  body: string | null | undefined,
  milestoneDueOn: string | null | undefined,
  labels: string[],
  bodyDueRegex: RegExp,
  bodyStartRegex: RegExp
): ParsedDates | null {
  let dueDate: Date | null = null;
  let startDate: Date | null = null;

  // 1. Milestone due date as default
  if (milestoneDueOn) {
    dueDate = parseDateString(milestoneDueOn);
  }

  // 2. Check labels for due dates (e.g., due:2026-10-15, deadline-2026-10-15, due/2026-10-15)
  for (const label of labels) {
    const labelMatch = /^(?:due|deadline)[:\-_/\s]+(\d{4}-\d{2}-\d{2})$/i.exec(label.trim());
    if (labelMatch) {
      const parsed = parseDateString(labelMatch[1]);
      if (parsed) dueDate = parsed;
    }
    const startMatch = /^(?:start)[:\-_/\s]+(\d{4}-\d{2}-\d{2})$/i.exec(label.trim());
    if (startMatch) {
      const parsed = parseDateString(startMatch[1]);
      if (parsed) startDate = parsed;
    }
  }

  // 3. Check issue body using configured regex
  if (body) {
    const dueMatch = bodyDueRegex.exec(body);
    if (dueMatch && dueMatch[1]) {
      const parsed = parseDateString(dueMatch[1]);
      if (parsed) dueDate = parsed;
    }

    const startMatch = bodyStartRegex.exec(body);
    if (startMatch && startMatch[1]) {
      const parsed = parseDateString(startMatch[1]);
      if (parsed) startDate = parsed;
    }
  }

  const range = normalizeDateRange(startDate, dueDate);
  return range && { ...range, isAllDay: true };
}

/**
 * Calculates RFC 5545 exclusive DTEND for all-day events.
 * For an all-day event on 2026-10-15, DTSTART is 20261015, DTEND is 20261016.
 */
export function calculateExclusiveEndDate(date: Date): Date {
  const nextDay = new Date(date.getTime());
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  return nextDay;
}

/**
 * Formats a Date object into iCal format:
 * - All day: YYYYMMDD
 * - DateTime: YYYYMMDDTHHMMSSZ
 */
export function formatIcsDate(date: Date, isAllDay: boolean): string {
  const pad = (n: number) => n.toString().padStart(2, '0');
  const year = date.getUTCFullYear();
  const month = pad(date.getUTCMonth() + 1);
  const day = pad(date.getUTCDate());

  if (isAllDay) {
    return `${year}${month}${day}`;
  }

  const hours = pad(date.getUTCHours());
  const minutes = pad(date.getUTCMinutes());
  const seconds = pad(date.getUTCSeconds());
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}
