/** Fallbacks for inputs left empty. Kept in sync with the defaults in action.yml (checked by the tests). */
export const DEFAULTS = {
  dateFieldNames: 'Due Date, Due, Target Date, Date, End Date',
  startDateFieldNames: 'Start Date, Start',
  closedStatusValues: 'Done, Closed, Completed, Finished',
  outputFile: 'calendar.ics',
  calendarName: 'GitHub Issues & Projects Calendar',
  calendarDescription: 'Calendar feed synchronized from GitHub Issues and Project cards',
  issueBodyDueRegex: String.raw`(?:\*{1,2}|_)?(?:due|due date|deadline|target date)(?:\*{1,2}|_)?[:\s]+\s*(\d{4}-\d{2}-\d{2})`,
  issueBodyStartRegex: String.raw`(?:\*{1,2}|_)?(?:start|start date)(?:\*{1,2}|_)?[:\s]+\s*(\d{4}-\d{2}-\d{2})`,
} as const;
