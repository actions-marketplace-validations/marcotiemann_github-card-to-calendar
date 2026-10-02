import * as core from '@actions/core';
import { getOctokit } from '@actions/github';
import { CalendarCard, ActionConfig } from './types.js';
import { extractIssueDates, calculateExclusiveEndDate } from './dates.js';
import { passesLabelFilters, passesAssigneeFilter } from './filters.js';

export async function fetchIssuesFromRepositories(
  config: ActionConfig
): Promise<CalendarCard[]> {
  const cards: CalendarCard[] = [];
  if (!config.repositories || config.repositories.length === 0) {
    return cards;
  }

  const octokit = getOctokit(config.token);

  for (const repoStr of config.repositories) {
    const trimmed = repoStr.trim();
    if (!trimmed) continue;

    const parts = trimmed.split('/');
    if (parts.length !== 2) {
      core.warning(`Invalid repository format: "${trimmed}". Expected "owner/repo". Skipping.`);
      continue;
    }

    const [owner, repo] = parts;
    core.info(`Fetching issues from ${owner}/${repo}...`);

    try {
      const stateFilter = config.includeClosed ? 'all' : 'open';
      const iterator = octokit.paginate.iterator(octokit.rest.issues.listForRepo, {
        owner,
        repo,
        state: stateFilter,
        per_page: 100,
      });

      for await (const response of iterator) {
        for (const issue of response.data) {
          // GitHub issues endpoint also returns pull requests; filter them out
          if (issue.pull_request) {
            continue;
          }

          const labelNames = (issue.labels || []).map((l) =>
            typeof l === 'string' ? l : l.name || ''
          ).filter(Boolean);

          if (!passesLabelFilters(labelNames, config.includeLabels, config.excludeLabels)) continue;


          const assigneeLogins = (issue.assignees || []).map((a) => a.login);
          if (!passesAssigneeFilter(assigneeLogins, config.includeAssignees)) continue;

          // Extract dates
          const dates = extractIssueDates(
            issue.body,
            issue.milestone?.due_on,
            labelNames,
            config.issueBodyDueRegex,
            config.issueBodyStartRegex
          );

          if (!dates || !dates.startDate || !dates.dueDate) {
            // No valid dates found; skip for calendar
            continue;
          }

          const assignees = (issue.assignees || [])
            .map((a) => `@${a.login}`)
            .join(', ');

          let description = `Issue: ${issue.html_url}\nState: ${issue.state}`;
          if (assignees) {
            description += `\nAssignees: ${assignees}`;
          }
          if (labelNames.length > 0) {
            description += `\nLabels: ${labelNames.join(', ')}`;
          }
          if (issue.milestone) {
            description += `\nMilestone: ${issue.milestone.title}`;
          }
          if (config.includeDescription && issue.body) {
            const cleanBody = issue.body.replace(/\r\n/g, '\n').slice(0, 1000);
            description += `\n\n---\n${cleanBody}`;
          }

          cards.push({
            uid: `gh-issue-${owner}-${repo}-${issue.number}@github.com`,
            title: `${issue.title} (#${issue.number})`,
            url: issue.html_url,
            startDate: dates.startDate,
            endDate: dates.isAllDay ? calculateExclusiveEndDate(dates.dueDate) : dates.dueDate,
            isAllDay: dates.isAllDay,
            labels: labelNames,
            repository: `${owner}/${repo}`,
            status: issue.state === 'closed' ? 'closed' : 'open',
            description,
            source: 'issue',
            updatedAt: new Date(issue.updated_at),
          });
        }
      }
    } catch (err: unknown) {
      const message = `Failed to fetch issues from ${owner}/${repo}: ${err instanceof Error ? err.message : String(err)}`;
      if (config.failOnError) throw new Error(message);
      core.error(message);
    }
  }

  return cards;
}
