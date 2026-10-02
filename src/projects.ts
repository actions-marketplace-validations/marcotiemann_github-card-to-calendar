import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { CalendarCard, ActionConfig, ProjectRef } from './types.js';
import {
  parseDateString,
  extractIssueDates,
  calculateExclusiveEndDate,
  normalizeDateRange,
} from './dates.js';
import { passesLabelFilters, passesAssigneeFilter } from './filters.js';
import { withBody } from './description.js';
import { withRetry } from './retry.js';

interface ProjectV2FieldValueDate {
  date?: string;
  field?: {
    name?: string;
  };
}

interface ProjectV2FieldValueSingleSelect {
  name?: string;
  field?: {
    name?: string;
  };
}

/** Org-level "issue fields" (e.g. a Target date set on the issue) surface in projects as this type. */
interface ProjectV2FieldValueIssueField {
  issueFieldValue?: {
    __typename?: string;
    value?: string;
  } | null;
  field?: {
    name?: string;
  };
}

interface ProjectV2ItemNode {
  id: string;
  type: string;
  updatedAt?: string;
  fieldValues?: {
    pageInfo?: { hasNextPage: boolean };
    nodes?: Array<
      ProjectV2FieldValueDate & ProjectV2FieldValueSingleSelect & ProjectV2FieldValueIssueField
    >;
  };
  content?: {
    __typename?: string;
    title?: string;
    url?: string;
    number?: number;
    state?: string;
    body?: string;
    repository?: {
      nameWithOwner?: string;
    };
    milestone?: {
      title?: string;
      dueOn?: string;
    } | null;
    labels?: {
      nodes?: Array<{ name: string }>;
    };
    assignees?: {
      nodes?: Array<{ login: string }>;
    };
  } | null;
}

interface ProjectV2GraphQLResponse {
  organization?: {
    projectV2?: {
      title: string;
      items: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: ProjectV2ItemNode[];
      };
    };
  };
  user?: {
    projectV2?: {
      title: string;
      items: {
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
        nodes: ProjectV2ItemNode[];
      };
    };
  };
}

/** Selection shared by issues and pull requests. */
const ISSUE_LIKE_FIELDS = `
        title
        url
        number
        state
        body
        repository {
          nameWithOwner
        }
        milestone {
          title
          dueOn
        }
        labels(first: 100) {
          nodes {
            name
          }
        }
        assignees(first: 20) {
          nodes {
            login
          }
        }
`;

const ITEM_FIELDS = `
  pageInfo {
    hasNextPage
    endCursor
  }
  nodes {
    id
    type
    updatedAt
    fieldValues(first: 100) {
      pageInfo {
        hasNextPage
      }
      nodes {
        ... on ProjectV2ItemFieldDateValue {
          date
          field {
            ... on ProjectV2FieldCommon {
              name
            }
          }
        }
        ... on ProjectV2ItemIssueFieldValue {
          field {
            ... on ProjectV2FieldCommon {
              name
            }
          }
          issueFieldValue {
            __typename
            ... on IssueFieldDateValue {
              value
            }
          }
        }
        ... on ProjectV2ItemFieldSingleSelectValue {
          name
          field {
            ... on ProjectV2FieldCommon {
              name
            }
          }
        }
      }
    }
    content {
      __typename
      ... on Issue {${ISSUE_LIKE_FIELDS}}
      ... on PullRequest {${ISSUE_LIKE_FIELDS}}
      ... on DraftIssue {
        title
        body
        assignees(first: 20) {
          nodes {
            login
          }
        }
      }
    }
  }
`;

function buildQuery(ownerType: 'organization' | 'user'): string {
  return `
  query getProjectItems($owner: String!, $number: Int!, $cursor: String) {
    ${ownerType}(login: $owner) {
      projectV2(number: $number) {
        title
        items(first: 100, after: $cursor) {${ITEM_FIELDS}}
      }
    }
  }
`;
}

const ORG_QUERY = buildQuery('organization');
const USER_QUERY = buildQuery('user');

export async function fetchProjectsV2Items(
  config: ActionConfig
): Promise<CalendarCard[]> {
  const cards: CalendarCard[] = [];
  for (const ref of config.projects) {
    cards.push(...(await fetchProject(config, ref)));
  }
  return cards;
}

/** Stable UID for issue/PR cards, shared with the repo scan so moving between projects is not a delete + create. */
function cardUid(itemId: string, content: ProjectV2ItemNode['content']): string {
  const m = content?.url ? /github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/i.exec(content.url) : null;
  if (m) {
    const kind = m[3].toLowerCase() === 'pull' ? 'pull' : 'issue';
    return `gh-${kind}-${m[1]}-${m[2]}-${m[4]}@github.com`;
  }
  return `gh-pv2-${itemId}@github.com`;
}

async function fetchProject(config: ActionConfig, ref: ProjectRef): Promise<CalendarCard[]> {
  const cards: CalendarCard[] = [];
  const octokit = getOctokit(config.token);
  const owner = ref.owner;
  const projectNumber = ref.number;

  core.info(`Fetching GitHub Projects v2 items for ${owner} / project #${projectNumber}...`);

  let isOrg = ref.ownerType === 'organization';
  let cursor: string | null = null;
  let hasNextPage = true;
  let queryToUse = isOrg ? ORG_QUERY : USER_QUERY;

  // If owner type not explicitly specified, try org first, fall back to user
  let initialResponse: ProjectV2GraphQLResponse | null = null;
  if (!ref.ownerType) {
    try {
      const probeResponse: ProjectV2GraphQLResponse = await withRetry(() =>
        octokit.graphql(ORG_QUERY, { owner, number: projectNumber, cursor: null })
      );
      if (probeResponse.organization?.projectV2) {
        isOrg = true;
        queryToUse = ORG_QUERY;
        initialResponse = probeResponse;
      } else {
        isOrg = false;
        queryToUse = USER_QUERY;
      }
    } catch (err: unknown) {
      // Expected when the owner is a user (GraphQL NOT_FOUND for the organization);
      // anything else (bad token, rate limit) will resurface in the user query below.
      core.debug(`Organization probe failed, trying user: ${err instanceof Error ? err.message : String(err)}`);
      isOrg = false;
      queryToUse = USER_QUERY;
    }
  }

  while (hasNextPage) {
    try {
      const response: ProjectV2GraphQLResponse =
        initialResponse ||
        (await withRetry(() =>
          octokit.graphql<ProjectV2GraphQLResponse>(queryToUse, { owner, number: projectNumber, cursor })
        ));
      initialResponse = null;

      const project = isOrg
        ? response.organization?.projectV2
        : response.user?.projectV2;

      if (!project) {
        const message = `Projects v2 not found for ${owner} #${projectNumber}. Verify project number and owner.`;
        if (config.failOnError) throw new Error(message);
        core.warning(message);
        break;
      }

      const projectBaseUrl = isOrg
        ? `https://github.com/orgs/${owner}/projects/${projectNumber}`
        : `https://github.com/users/${owner}/projects/${projectNumber}`;

      for (const item of project.items.nodes) {
        const content = item.content;
        const title = content?.title || 'Untitled Card';
        const url = content?.url || `${projectBaseUrl}?pane=issue&itemId=${item.id}`;
        const repo = content?.repository?.nameWithOwner;
        const labels: string[] = (content?.labels?.nodes || []).map((l) => l.name);

        if (item.fieldValues?.pageInfo?.hasNextPage) {
          core.warning(`"${title}" has more than 100 field values; some date fields may be missed.`);
        }

        // Closed by issue/PR state...
        let isClosed = false;
        if (content?.state && ['CLOSED', 'MERGED'].includes(content.state.toUpperCase())) {
          isClosed = true;
        }

        // Normalise issue-field date values to the same shape as project date fields
        const fieldNodes = (item.fieldValues?.nodes || []).map((fv) =>
          fv.issueFieldValue?.__typename === 'IssueFieldDateValue' && fv.issueFieldValue.value
            ? { ...fv, date: fv.issueFieldValue.value }
            : fv
        );
        // ...or by a "Status" single-select value such as "Done"
        for (const fv of fieldNodes) {
          if (fv.field?.name?.toLowerCase() === 'status') {
            const statusVal = fv.name?.toLowerCase() || '';
            if (config.closedStatusValues.includes(statusVal)) {
              isClosed = true;
            }
          }
        }

        if (isClosed && !config.includeClosed) {
          continue;
        }

        if (!passesLabelFilters(labels, config.includeLabels, config.excludeLabels)) continue;
        const assigneeLogins = (content?.assignees?.nodes || []).map((a) => a.login);
        if (!passesAssigneeFilter(assigneeLogins, config.includeAssignees)) continue;

        // Extract dates: check custom date fields
        let startDate: Date | null = null;
        let dueDate: Date | null = null;

        for (const fv of fieldNodes) {
          const fieldName = fv.field?.name || '';
          if (!fv.date) continue;

          // Check Due / Target Date
          if (config.dateFieldNames.some((n) => n.toLowerCase() === fieldName.toLowerCase())) {
            const parsed = parseDateString(fv.date);
            if (parsed) dueDate = parsed;
          }

          // Check Start Date
          if (config.startDateFieldNames.some((n) => n.toLowerCase() === fieldName.toLowerCase())) {
            const parsed = parseDateString(fv.date);
            if (parsed) startDate = parsed;
          }
        }

        // Fallback: check milestone, content body, or labels if it is an Issue/PR
        if (!dueDate && !startDate && (content?.body || content?.milestone?.dueOn || labels.length > 0)) {
          const fallbackDates = extractIssueDates(
            content?.body,
            content?.milestone?.dueOn,
            labels,
            config.issueBodyDueRegex,
            config.issueBodyStartRegex
          );
          if (fallbackDates) {
            startDate = fallbackDates.startDate;
            dueDate = fallbackDates.dueDate;
          }
        }

        const range = normalizeDateRange(startDate, dueDate);
        if (!range) continue; // no date found on card

        let description = `Card: ${url}\nType: ${item.type}`;
        if (repo) description += `\nRepository: ${repo}`;
        if (labels.length > 0) description += `\nLabels: ${labels.join(', ')}`;
        if (config.includeDescription && content?.body) {
          const cleanBody = content.body.replace(/\r\n/g, '\n').slice(0, 1000);
          description += `\n\n---\n${cleanBody}`;
        }

        cards.push({
          uid: cardUid(item.id, content),
          title,
          url,
          startDate: range.startDate,
          endDate: calculateExclusiveEndDate(range.dueDate),
          isAllDay: true,
          labels,
          repository: repo,
          status: isClosed ? 'closed' : 'open',
          description,
          source: 'project_v2',
          updatedAt: item.updatedAt ? new Date(item.updatedAt) : undefined,
        });
      }

      hasNextPage = project.items.pageInfo.hasNextPage;
      cursor = project.items.pageInfo.endCursor;
    } catch (err: unknown) {
      if (config.failOnError) throw err;
      core.error(`Error querying Projects v2: ${err instanceof Error ? err.message : String(err)}`);
      break;
    }
  }

  return cards;
}
