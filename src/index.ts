import * as fs from 'fs';
import * as path from 'path';
import * as core from '@actions/core';
import { ActionConfig, CalendarCard } from './types.js';
import { fetchIssuesFromRepositories } from './issues.js';
import { fetchProjectsV2Items } from './projects.js';
import { generateIcs } from './ical.js';
import { mergeCards } from './merge.js';
import { parseProjectRefs, uniqueProjectRefs } from './project-refs.js';
import { LANDING_MARKER, renderLandingPage } from './landing.js';

function parseListInput(input: string): string[] {
  if (!input) return [];
  return input
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseRegexInput(input: string, defaultPattern: string, flags = 'i'): RegExp {
  try {
    return new RegExp(input || defaultPattern, flags);
  } catch (err) {
    core.warning(`Invalid regex "${input}", falling back to default: ${defaultPattern}`);
    return new RegExp(defaultPattern, flags);
  }
}

async function run(): Promise<void> {
  try {
    const token = core.getInput('github-token', { required: true });
    const repositories = parseListInput(core.getInput('repositories'));
    const projectOwnerTypeRaw = core.getInput('project-owner-type')?.toLowerCase();
    const projectOwnerType =
      projectOwnerTypeRaw === 'organization' || projectOwnerTypeRaw === 'user'
        ? (projectOwnerTypeRaw as 'organization' | 'user')
        : undefined;
    // `projects` ("owner/number" list) plus the legacy single-project inputs
    const projectRefs = parseProjectRefs(parseListInput(core.getInput('projects')));
    const legacyOwner = core.getInput('project-owner');
    const legacyNumber = parseInt(core.getInput('project-number'), 10);
    if (legacyOwner && legacyNumber) {
      projectRefs.push({ owner: legacyOwner, number: legacyNumber, ownerType: projectOwnerType });
    }
    const projects = uniqueProjectRefs(projectRefs);

    const includeLabels = parseListInput(core.getInput('include-labels'));
    const excludeLabels = parseListInput(core.getInput('exclude-labels'));
    const includeAssignees = parseListInput(core.getInput('include-assignees'));

    const dateFieldNames = parseListInput(
      core.getInput('date-field-names') || 'Due Date, Due, Target Date, Date, End Date'
    );
    const startDateFieldNames = parseListInput(
      core.getInput('start-date-field-names') || 'Start Date, Start'
    );

    const defaultDueRegex = '(?:\\*{1,2}|_)?(?:due|due date|deadline|target date)(?:\\*{1,2}|_)?[:\\s]+\\s*(\\d{4}-\\d{2}-\\d{2})';
    const defaultStartRegex = '(?:\\*{1,2}|_)?(?:start|start date)(?:\\*{1,2}|_)?[:\\s]+\\s*(\\d{4}-\\d{2}-\\d{2})';

    const issueBodyDueRegex = parseRegexInput(
      core.getInput('issue-body-due-regex'),
      defaultDueRegex
    );
    const issueBodyStartRegex = parseRegexInput(
      core.getInput('issue-body-start-regex'),
      defaultStartRegex
    );

    const outputFile = core.getInput('output-file') || 'calendar.ics';
    const calendarName = core.getInput('calendar-name') || 'GitHub Issues & Projects Calendar';
    const calendarDescription =
      core.getInput('calendar-description') ||
      'Calendar feed synchronized from GitHub Issues and Project cards';
    const includeClosed = core.getInput('include-closed').trim().toLowerCase() === 'true';
    const includeDescription = core.getInput('include-description').trim().toLowerCase() !== 'false';
    const failOnError = core.getInput('fail-on-error').trim().toLowerCase() === 'true';
    const closedStatusValues = parseListInput(
      core.getInput('closed-status-values') || 'Done, Closed, Completed, Finished'
    ).map((v) => v.toLowerCase());

    const config: ActionConfig = {
      token,
      repositories,
      projects,
      includeLabels,
      excludeLabels,
      includeAssignees,
      dateFieldNames,
      startDateFieldNames,
      issueBodyDueRegex,
      issueBodyStartRegex,
      calendarName,
      calendarDescription,
      outputFile,
      includeClosed,
      closedStatusValues,
      includeDescription,
      failOnError,
    };

    core.info('Starting GitHub Card to Calendar sync...');
    if (repositories.length > 0) {
      core.info(`Target repositories (${repositories.length}): ${repositories.join(', ')}`);
    }
    if (projects.length > 0) {
      core.info(`Target projects (${projects.length}): ${projects.map((p) => `${p.owner}/${p.number}`).join(', ')}`);
    }
    if (includeLabels.length > 0) {
      core.info(`Label filter (include): ${includeLabels.join(', ')}`);
    }
    if (includeAssignees.length > 0) {
      core.info(`Assignee filter: ${includeAssignees.join(', ')}`);
    }
    if (excludeLabels.length > 0) {
      core.info(`Label filter (exclude): ${excludeLabels.join(', ')}`);
    }

    // 1. Fetch from repositories
    const issueCards = await fetchIssuesFromRepositories(config);
    core.info(`Fetched ${issueCards.length} scheduled issue(s) from repositories.`);

    // 2. Fetch from GitHub Projects v2
    const projectCards = await fetchProjectsV2Items(config);
    core.info(`Fetched ${projectCards.length} scheduled item(s) from Projects v2.`);

    // 3. De-duplicate:
    // 3. De-duplicate issues that appear both in the repo scan and in a project board
    const uniqueCards = mergeCards([...issueCards, ...projectCards]);
    core.info(`Total unique scheduled calendar events: ${uniqueCards.length}`);

    // 4. Generate RFC 5545 .ics content
    const icsContent = generateIcs(uniqueCards, config);

    // 5. Write to output file
    const resolvedPath = path.resolve(process.cwd(), outputFile);
    const outputDir = path.dirname(resolvedPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Output is deterministic, so skip the write when nothing changed (avoids empty deploys)
    const unchanged = fs.existsSync(resolvedPath) && fs.readFileSync(resolvedPath, 'utf-8') === icsContent;
    if (unchanged) {
      core.info(`Calendar unchanged, left ${resolvedPath} as is`);
    } else {
      fs.writeFileSync(resolvedPath, icsContent, 'utf-8');
      core.info(`Calendar written to ${resolvedPath}`);
    }

    // Create .nojekyll to ensure GitHub Pages serves raw files without Jekyll processing
    const nojekyllPath = path.join(outputDir, '.nojekyll');
    if (!fs.existsSync(nojekyllPath)) {
      fs.writeFileSync(nojekyllPath, '', 'utf-8');
    }

    // Landing page with one-click Google Calendar subscription. Regenerated on every run
    // (so the event count stays current), unless the user replaced it with their own page.
    const indexPath = path.join(outputDir, 'index.html');
    const existingIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf-8') : null;
    if (existingIndex === null || existingIndex.includes(LANDING_MARKER)) {
      fs.writeFileSync(
        indexPath,
        renderLandingPage(calendarName, calendarDescription, uniqueCards.length, path.basename(outputFile)),
        'utf-8'
      );
      core.info(`Wrote GitHub Pages landing page to ${indexPath}`);
    }

    // Set GitHub Action outputs
    core.setOutput('ics-path', resolvedPath);
    core.setOutput('events-count', uniqueCards.length.toString());

    // Generate Step Summary
    await core.summary
      .addHeading('📅 GitHub Card to Calendar')
      .addTable([
        [
          { data: 'Metric', header: true },
          { data: 'Value', header: true },
        ],
        ['Events Count', uniqueCards.length.toString()],
        ['Output File', outputFile],
        ['Calendar Name', calendarName],
        ['Filter Labels', includeLabels.join(', ') || '(All cards with dates)'],
      ])
      .write();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    core.setFailed(`Action failed with error: ${message}`);
  }
}

run();
