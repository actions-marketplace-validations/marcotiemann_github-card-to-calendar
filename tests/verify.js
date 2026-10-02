import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  parseDateString,
  extractIssueDates,
  calculateExclusiveEndDate,
  formatIcsDate,
  normalizeDateRange,
} from '../src/dates.js';
import { generateIcs } from '../src/ical.js';
import { passesAssigneeFilter, passesLabelFilters } from '../src/filters.js';
import { parseProjectRefs, uniqueProjectRefs } from '../src/project-refs.js';
import { mergeCards } from '../src/merge.js';
import { renderLandingPage, LANDING_MARKER } from '../src/landing.js';
import { withBody } from '../src/description.js';
import { withRetry, isTransientError } from '../src/retry.js';
import { DEFAULTS } from '../src/defaults.js';

test('date parsing', () => {
  const d1 = parseDateString('2026-10-15');
  assert.ok(d1, 'Should parse YYYY-MM-DD');
  assert.equal(d1.getUTCFullYear(), 2026);
  assert.equal(d1.getUTCMonth(), 9);
  assert.equal(d1.getUTCDate(), 15);

  // ISO milestone format
  const d2 = parseDateString('2026-10-15T07:00:00Z');
  assert.ok(d2, 'Should parse ISO string');
  assert.equal(d2.getUTCDate(), 15, 'Milestone ISO date should not roll over');

  const dInvalid = parseDateString('not-a-date');
  assert.equal(dInvalid, null, 'Invalid date string should return null');
});

test('issue date extraction from body, labels and milestone', () => {
  const dueRegex = /(?:\*{1,2}|_)?(?:due|due date|deadline|target date)(?:\*{1,2}|_)?[:\s]+\s*(\d{4}-\d{2}-\d{2})/i;
  const startRegex = /(?:\*{1,2}|_)?(?:start|start date)(?:\*{1,2}|_)?[:\s]+\s*(\d{4}-\d{2}-\d{2})/i;

  // Markdown bold due date
  const body1 = '### Task\n**Due date**: 2026-11-20\nSome details';
  const res1 = extractIssueDates(body1, null, [], dueRegex, startRegex);
  assert.ok(res1, 'Should extract bold markdown due date');
  assert.equal(res1.dueDate?.getUTCDate(), 20);

  // Label due date
  const res2 = extractIssueDates('', null, ['bug', 'due:2026-12-01'], dueRegex, startRegex);
  assert.ok(res2, 'Should extract due date from label');
  assert.equal(res2.dueDate?.getUTCDate(), 1);

  // Milestone fallback
  const res3 = extractIssueDates('', '2026-10-31T07:00:00Z', [], dueRegex, startRegex);
  assert.ok(res3, 'Should extract due date from milestone');
  assert.equal(res3.dueDate?.getUTCDate(), 31);
});

test('all-day DTEND is exclusive', () => {
  const start = new Date(Date.UTC(2026, 9, 15));
  const exclusiveEnd = calculateExclusiveEndDate(start);
  assert.equal(exclusiveEnd.getUTCDate(), 16, 'DTEND must be next day for RFC 5545 all-day');
  assert.equal(formatIcsDate(start, true), '20261015');
  assert.equal(formatIcsDate(exclusiveEnd, true), '20261016');
});

test('iCalendar output and category escaping', () => {
  const mockCards = [
    {
      uid: 'test-1@github.com',
      title: 'Fix issue with login',
      url: 'https://github.com/org/repo/issues/1',
      startDate: new Date(Date.UTC(2026, 9, 10)),
      endDate: new Date(Date.UTC(2026, 9, 11)),
      isAllDay: true,
      labels: ['bug', 'calendar,urgent'],
      status: 'open',
      description: 'Long description that needs escaping: a, b; c \\ d\nNew line',
      source: 'issue',
    },
  ];

  const mockConfig = {
    token: 'fake',
    repositories: [],
    includeLabels: [],
    excludeLabels: [],
    dateFieldNames: [],
    startDateFieldNames: [],
    issueBodyDueRegex: /./,
    issueBodyStartRegex: /./,
    calendarName: 'Test Calendar',
    calendarDescription: 'Testing calendar generation',
    outputFile: 'calendar.ics',
    includeClosed: false,
  };

  const ics = generateIcs(mockCards, mockConfig);
  assert.ok(ics.includes('BEGIN:VCALENDAR'), 'Contains VCALENDAR');
  assert.ok(ics.includes('BEGIN:VEVENT'), 'Contains VEVENT');
  assert.ok(ics.includes('DTSTART;VALUE=DATE:20261010'), 'Contains DTSTART');
  assert.ok(ics.includes('DTEND;VALUE=DATE:20261011'), 'Contains DTEND');
  // Check that categories separator is unescaped comma, while label with comma is escaped
  assert.ok(ics.includes('CATEGORIES:bug,calendar\\,urgent'), 'Categories properly escaped according to RFC 5545');
  assert.ok(ics.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'), 'Contains refresh interval hint');
});

test('line folding keeps emoji intact and lines under 75 octets', () => {
  const mockConfig = {
    token: 'fake',
    repositories: [],
    includeLabels: [],
    excludeLabels: [],
    dateFieldNames: [],
    startDateFieldNames: [],
    issueBodyDueRegex: /./,
    issueBodyStartRegex: /./,
    calendarName: 'Test Calendar',
    calendarDescription: 'Testing calendar generation',
    outputFile: 'calendar.ics',
    includeClosed: false,
  };

  const longTitleWithEmoji = 'Sprint Planning 📅 ' + 'A'.repeat(60) + ' 🚀 Next Gen Launch Event Across Regions';
  const mockCard = {
    uid: 'emoji-test@github.com',
    title: longTitleWithEmoji,
    url: 'https://github.com/org/repo/issues/2',
    startDate: new Date(Date.UTC(2026, 9, 20)),
    endDate: new Date(Date.UTC(2026, 9, 21)),
    isAllDay: true,
    labels: ['roadmap'],
    status: 'open',
    source: 'issue',
  };
  const ics = generateIcs([mockCard], mockConfig);
  const lines = ics.split('\r\n').filter(Boolean);
  for (const line of lines) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `Line exceeds 75 octets: ${line}`);
    assert.ok(!line.includes('\uFFFD'), 'Emoji surrogate pair was corrupted by line folding');
  }
});

test('merge keeps the issue UID, closed cards stay visible, landing page is escaped', () => {
  const base = {
    title: 't',
    startDate: new Date(Date.UTC(2026, 9, 10)),
    endDate: new Date(Date.UTC(2026, 9, 11)),
    isAllDay: true,
    labels: [],
    status: 'open',
  };
  const issue = { ...base, uid: 'gh-issue-o-r-1@github.com', url: 'https://github.com/o/r/issues/1', source: 'issue' };
  const proj = { ...base, uid: 'gh-pv2-abc@github.com', url: 'https://github.com/o/r/issues/1', source: 'project_v2' };
  const merged = mergeCards([issue, proj]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'project_v2');
  assert.equal(merged[0].uid, issue.uid, 'UID must stay stable when an issue joins a project');

  const config = {
    token: 'x', repositories: [], includeLabels: [], excludeLabels: [], dateFieldNames: [],
    startDateFieldNames: [], issueBodyDueRegex: /./, issueBodyStartRegex: /./,
    calendarName: 'c', calendarDescription: 'd', outputFile: 'c.ics',
    includeClosed: true, closedStatusValues: [],
  };
  const ics = generateIcs([{ ...issue, status: 'closed' }], config);
  assert.ok(ics.includes('STATUS:CONFIRMED') && !ics.includes('CANCELLED'), 'Closed events must not be CANCELLED');
  assert.ok(ics.includes('SUMMARY:✓ t'), 'Closed events are marked in the title');

  const html = renderLandingPage('A & <b>"x"</b>', '</script><script>1', 3, 'cal.ics');
  assert.ok(html.includes('A &amp; &lt;b&gt;&quot;x&quot;&lt;/b&gt;'), 'Name is HTML-escaped');
  assert.ok(!html.includes('<script>1'), 'Description is HTML-escaped');
  assert.ok(html.includes(LANDING_MARKER), 'Landing page carries regeneration marker');
});

test('label filters and deterministic output', () => {
  assert.ok(passesLabelFilters(['Bug'], [], []));
  assert.ok(passesLabelFilters(['Calendar'], ['calendar'], []), 'include is case-insensitive');
  assert.ok(!passesLabelFilters(['bug'], ['calendar'], []), 'missing include label is rejected');
  assert.ok(!passesLabelFilters(['calendar', 'WONTFIX'], ['calendar'], ['wontfix']), 'exclude wins');

  const card = {
    uid: 'u@github.com', title: 't', url: 'https://github.com/o/r/issues/1',
    startDate: new Date(Date.UTC(2026, 9, 10)), endDate: new Date(Date.UTC(2026, 9, 11)),
    isAllDay: true, labels: [], status: 'open', source: 'issue', updatedAt: new Date('2026-10-01T12:00:00Z'),
  };
  const cfg = { calendarName: 'c', calendarDescription: 'd' };
  assert.equal(generateIcs([card], cfg), generateIcs([card], cfg), 'Output must be deterministic');
  assert.ok(generateIcs([card], cfg).includes('DTSTAMP:20261001T120000Z'));
});

test('project reference parsing', () => {
  const refs = parseProjectRefs(['example-org/16', ' my-org#9 ']);
  assert.deepEqual(refs, [{ owner: 'example-org', number: 16 }, { owner: 'my-org', number: 9 }]);
  assert.equal(uniqueProjectRefs([...refs, { owner: 'EXAMPLE-ORG', number: 16 }]).length, 2, 'duplicates collapse');
  assert.throws(() => parseProjectRefs(['example-org']), /Invalid project/);
  assert.throws(() => parseProjectRefs(['a/b']), /Invalid project/);
});

test('assignee filter', () => {
  assert.ok(passesAssigneeFilter([], []), 'no filter keeps everything');
  assert.ok(passesAssigneeFilter(['OctoCat', 'x'], ['octocat']), 'case-insensitive match');
  assert.ok(passesAssigneeFilter(['octocat'], ['@octocat']), 'leading @ ignored');
  assert.ok(!passesAssigneeFilter([], ['octocat']), 'unassigned cards are dropped');
  assert.ok(!passesAssigneeFilter(['other'], ['octocat']), 'other assignees are dropped');
});

test('date ranges are completed and ordered', () => {
  const a = new Date(Date.UTC(2026, 9, 10));
  const b = new Date(Date.UTC(2026, 9, 20));
  assert.equal(normalizeDateRange(null, undefined), null, 'no dates, no range');
  assert.deepEqual(normalizeDateRange(a, null), { startDate: a, dueDate: a }, 'lone start is a single day');
  assert.deepEqual(normalizeDateRange(null, b), { startDate: b, dueDate: b }, 'lone due is a single day');
  assert.deepEqual(normalizeDateRange(b, a), { startDate: a, dueDate: b }, 'reversed dates are swapped');
  assert.notEqual(normalizeDateRange(a, b).startDate, a, 'result does not alias the inputs');
});

test('issue bodies are appended only when enabled and truncated', () => {
  assert.equal(withBody('d', 'body', false), 'd');
  assert.equal(withBody('d', '', true), 'd');
  assert.equal(withBody('d', null, true), 'd');
  assert.equal(withBody('d', 'a\r\nb', true), 'd\n\n---\na\nb', 'CRLF is normalised');
  assert.equal(withBody('d', 'x'.repeat(2000), true).length, 'd\n\n---\n'.length + 1000);
});

test('transient errors are retried, permanent ones are not', async () => {
  assert.ok(isTransientError({ status: 502 }));
  assert.ok(isTransientError({ status: 429 }));
  assert.ok(isTransientError({ status: 403, message: 'API rate limit exceeded' }));
  assert.ok(isTransientError({ errors: [{ type: 'RATE_LIMITED' }] }));
  assert.ok(isTransientError({ code: 'ECONNRESET' }));
  assert.ok(!isTransientError({ status: 401 }));
  assert.ok(!isTransientError({ errors: [{ type: 'NOT_FOUND' }] }));
  assert.ok(!isTransientError(new Error('boom')));

  const sleeps = [];
  const sleep = async (ms) => void sleeps.push(ms);

  let calls = 0;
  const result = await withRetry(
    async () => {
      if (++calls < 3) throw { status: 503 };
      return 'ok';
    },
    { sleep, delayMs: 10 }
  );
  assert.equal(result, 'ok');
  assert.deepEqual(sleeps, [10, 20], 'delay grows linearly');

  calls = 0;
  await assert.rejects(
    withRetry(async () => { calls++; throw { status: 401 }; }, { sleep }),
    (e) => e.status === 401
  );
  assert.equal(calls, 1, 'permanent errors fail immediately');

  calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw { status: 500 }; }, { sleep, attempts: 3 }));
  assert.equal(calls, 3, 'gives up after the configured attempts');
});

test('built-in body regexes match the documented formats', () => {
  const due = new RegExp(DEFAULTS.issueBodyDueRegex, 'i');
  const start = new RegExp(DEFAULTS.issueBodyStartRegex, 'i');
  assert.equal(due.exec('Due: 2026-10-25')[1], '2026-10-25');
  assert.equal(due.exec('**Target date**: 2026-10-25')[1], '2026-10-25');
  assert.equal(due.exec('_Deadline_ 2026-10-25')[1], '2026-10-25');
  assert.equal(start.exec('Start date: 2026-10-20')[1], '2026-10-20');
  assert.equal(due.exec('no dates here'), null);
});

test('defaults in action.yml match the code defaults', () => {
  const yml = readFileSync('action.yml', 'utf8').replace(/\r\n/g, '\n');
  const defaultOf = (input) => {
    const m = new RegExp(`^  ${input}:\n(?:    .*\n)*?    default: '(.*)'$`, 'm').exec(yml);
    assert.ok(m, `${input} has a default in action.yml`);
    return m[1];
  };
  assert.equal(defaultOf('date-field-names'), DEFAULTS.dateFieldNames);
  assert.equal(defaultOf('start-date-field-names'), DEFAULTS.startDateFieldNames);
  assert.equal(defaultOf('closed-status-values'), DEFAULTS.closedStatusValues);
  assert.equal(defaultOf('output-file'), DEFAULTS.outputFile);
  assert.equal(defaultOf('calendar-name'), DEFAULTS.calendarName);
  assert.equal(defaultOf('calendar-description'), DEFAULTS.calendarDescription);
});

test('landing page supports light and dark colour schemes', () => {
  assert.ok(renderLandingPage('n', 'd', 1, 'c.ics').includes('prefers-color-scheme: light'));
});
