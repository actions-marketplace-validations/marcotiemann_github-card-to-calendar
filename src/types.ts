export interface CalendarCard {
  uid: string;
  title: string;
  url: string;
  startDate: Date;
  endDate: Date;
  isAllDay: boolean;
  labels: string[];
  repository?: string;
  status: 'open' | 'closed';
  description?: string;
  source: 'issue' | 'project_v2';
  /** Last modification time; used for a stable DTSTAMP so unchanged feeds are byte-identical. */
  updatedAt?: Date;
}

export interface ProjectRef {
  owner: string;
  number: number;
  /** Auto-detected (organization first, then user) when omitted. */
  ownerType?: 'organization' | 'user';
}

export interface ActionConfig {
  token: string;
  repositories: string[];
  projects: ProjectRef[];
  includeLabels: string[];
  excludeLabels: string[];
  /** Only keep cards assigned to one of these logins (empty = no assignee filter). */
  includeAssignees: string[];
  dateFieldNames: string[];
  startDateFieldNames: string[];
  issueBodyDueRegex: RegExp;
  issueBodyStartRegex: RegExp;
  calendarName: string;
  calendarDescription: string;
  outputFile: string;
  includeClosed: boolean;
  /** Lower-cased Projects v2 "Status" values that mean a card is done. */
  closedStatusValues: string[];
  /** Include issue bodies in event descriptions (disable for private repos on public Pages). */
  includeDescription: boolean;
  /** Throw instead of logging when a repository or project cannot be fetched. */
  failOnError: boolean;
}
