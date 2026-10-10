# GitHub Card to Calendar 📅

A GitHub Action that turns dated issues and GitHub Projects v2 cards into an **iCalendar (`.ics`)** feed you can subscribe to in **Google Calendar**, Apple Calendar or Outlook.

Cards with only a target date appear as a one-day event; cards with a start and a target date appear as a multi-day event.

---

## Features

- **GitHub Projects v2**: read any number of user- or organization-owned projects (`projects: owner/number`).
- **Issue fields and project fields**: dates can come from org-level *issue fields* (e.g. **Target date**, **Start date**) or from ordinary project Date fields.
- **Multiple repositories**: optionally scan issues in repositories directly (`repositories`).
- **Other date sources**: milestone due dates, `Due: YYYY-MM-DD` text in the issue body, and `due:YYYY-MM-DD` labels.
- **Label filtering**: `include-labels` / `exclude-labels`.
- **De-duplication**: an issue that appears in several projects, or in a project *and* the repo scan, becomes one event with a stable UID.
- **Closed cards**: skipped by default; with `include-closed` they stay visible, prefixed with `✓`.
- **Hosting-friendly output**: RFC 5545 `.ics`, a landing page with an "Add to Google Calendar" button, and byte-identical output when nothing changed (no empty deploys).

---

## How It Works

```
 ┌───────────────────────────┐      ┌────────────────────────────┐
 │  GitHub Projects (v2)     │      │  Repositories (optional)   │
 │  Target / Start date      │      │  milestones, body, labels  │
 └─────────────┬─────────────┘      └─────────────┬──────────────┘
               └──────────────┬───────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │  GitHub Action                │
               │  filter → extract dates →     │
               │  merge duplicates → .ics      │
               └──────────────┬────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │  GitHub Pages (gh-pages)      │
               │  calendar.ics + index.html    │
               └──────────────┬────────────────┘
                              ▼
               ┌───────────────────────────────┐
               │  Google Calendar / Apple /    │
               │  Outlook: "Subscribe from URL"│
               └───────────────────────────────┘
```

---

## Quick Start

### Step 1: Create a Personal Access Token (PAT)

The built-in `GITHUB_TOKEN` **cannot** read organization or cross-repository projects, so you need a PAT:

1. Go to **GitHub Settings → Developer settings → Personal access tokens**.
2. Create a token:
   - **Classic**: scopes `repo` and `read:project`.
   - **Fine-grained**: set the organization as resource owner and grant read access to **Issues**, **Projects** and **Metadata**.
3. In the repository that will host the calendar, go to **Settings → Secrets and variables → Actions** and add a secret named `CALENDAR_GITHUB_TOKEN`.

### Step 2: Add the workflow

Create `.github/workflows/calendar-sync.yml` in your own calendar repository. This is a separate repository from the action itself: it holds only the workflow and the generated `gh-pages` branch, and can be private.

```yaml
name: Sync GitHub Cards to Calendar

on:
  schedule:
    - cron: '0 * * * *'      # hourly
  workflow_dispatch:          # manual run
  repository_dispatch:
    types: [calendar-update]  # optional external trigger

permissions:
  contents: write             # needed to push the gh-pages branch

concurrency:
  group: calendar-sync
  cancel-in-progress: false

jobs:
  sync-and-publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - name: Generate calendar
        uses: marcotiemann/github-card-to-calendar@v1
        with:
          github-token: ${{ secrets.CALENDAR_GITHUB_TOKEN }}
          projects: |
            my-org/16
            my-org/9
          date-field-names: 'Target date'
          start-date-field-names: 'Start date'
          include-description: false
          calendar-name: 'My Team Roadmap'
          output-file: 'public/<random-string>/calendar.ics'   # see "Privacy" below

      - name: Deploy to GitHub Pages
        uses: JamesIves/github-pages-deploy-action@v4
        with:
          folder: public
          branch: gh-pages
```

### Step 3: Subscribe

1. Enable Pages: **Settings → Pages → Deploy from a branch → `gh-pages` / `(root)`**.
2. Open `https://<user-or-org>.github.io/<repo>/<random-string>/` and click **Add to Google Calendar**, or copy the `calendar.ics` link into **Other calendars → From URL**.

> **Refresh timing:** the workflow regenerates the feed hourly, but Google Calendar decides when to re-fetch subscribed URLs (typically every 12–24 hours) and ignores the feed's refresh hints. Apple Calendar and Outlook honour them.

---

## Privacy

GitHub Pages sites are **public** (except on some Enterprise plans), so anyone with the link can read the feed: event titles, labels, links and, unless disabled, issue bodies. If you track private repositories:

- set `include-description: false` (removes issue/card bodies from the feed),
- keep sensitive details out of issue titles and labels,
- **publish the feed under an unguessable path**: write it to `public/<random-string>/calendar.ics` (generate the string with `openssl rand -hex 16`) and subscribe to that URL. This only hides the link, it is not access control, but it keeps the feed from being found by guessing `<user>.github.io/<repo>/calendar.ics`,
- or host the `.ics` somewhere access-controlled.

---

## Specifying Dates on Cards

### Single-day vs. multi-day events

| Card has | Event |
| :--- | :--- |
| target (due) date only | one all-day event on that date |
| start date only | one all-day event on that date |
| start **and** target date | all-day event spanning both dates, inclusive |
| start after target | the two dates are swapped |

All events are all-day. Times of day are not supported, and none are read from GitHub date fields (they hold dates only).

### Where dates are read from

**1. Projects v2 date fields and issue fields** (recommended). Matched by field name, case-insensitively, using `date-field-names` (end / target date) and `start-date-field-names` (start date). This covers both:

- org-level **issue fields** such as *Target date* and *Start date*, which GitHub shows in projects, and
- ordinary project **Date** fields.

If a card has no matching field value at all, the action falls back to the issue's milestone, body and labels (below).

**2. Milestone due date.** Used as the due date.

**3. Issue body.** Text such as:

```markdown
Due: 2026-10-25
Start: 2026-10-20
```

The built-in patterns accept `Due`, `Due date`, `Deadline`, `Target date` (and `Start`, `Start date`), with optional `**bold**` / `_italic_` markers. Override with `issue-body-due-regex` / `issue-body-start-regex` (case-insensitive; group 1 must capture `YYYY-MM-DD`).

**4. Labels.** `due:2026-10-25`, `deadline:2026-10-25`, `start:2026-10-20`.

For the repository scan, precedence is milestone < label < body (later wins).

> **Pull requests:** the `repositories` scan lists issues only. Pull requests appear only when they are cards in a project listed in `projects`.

> **Repository scan limitation:** the `repositories` scan cannot read issue fields. To use *Target date* / *Start date* issue fields, read them through a project (`projects`).

### Defaults to be aware of

`date-field-names` defaults to `Due Date, Due, Target Date, Date, End Date`. If your projects also have an unrelated *End date* or *Date* field, set `date-field-names` explicitly (for example `'Target date'`) so it is not treated as the due date.

---

## Real-Time Triggers (Optional)

You can refresh the calendar sooner than the hourly schedule by dispatching `calendar-update` from tracked repositories to **your calendar repository** (the one with the sync workflow, not this action's repository). See `.github/examples/child-repo-trigger.yml`:

```yaml
on:
  issues:
    types: [opened, edited, deleted, labeled, unlabeled, closed, reopened, milestoned, demilestoned]
```

This only reacts to **issue** events. Changes made purely in a project (such as editing a date field) do not fire a workflow event in the tracked repository, so they are picked up by the next scheduled run.

**Token:** the example reads a `CALENDAR_DISPATCH_TOKEN` secret, which you add to each tracked repository. Create a fine-grained personal access token limited to your **calendar repository** with the **Contents: Read and write** permission (GitHub requires it to send a `repository_dispatch` event), or a classic token with the `repo` scope.

**Cost:** every dispatch is one extra run of your sync workflow on top of the hourly schedule. Runs are short (typically under a minute). With the `concurrency` block shown above, a burst of events queues behind the running job and GitHub keeps only one pending run, so rapid-fire edits collapse into at most one extra run. Public repositories run for free; private ones count against your monthly Actions minutes.

**When it helps:** the dispatch only speeds up *your feed*. Google Calendar re-fetches subscribed URLs on its own schedule (typically every 12-24 hours), so if Google Calendar is your only client, the hourly schedule is already faster than Google picks it up and you can skip the dispatch. It is worth adding for Apple Calendar and Outlook, which honour the feed's refresh hints, or if you open the feed directly.

---

## Action Inputs

| Input | Default | Description |
| :--- | :--- | :--- |
| `github-token` (required) | | PAT with access to the issues and projects you read (see Step 1) |
| `projects` | | Comma/newline-separated Projects v2 as `owner/number` (e.g. `my-org/16, my-org/9`). Owner type is auto-detected. |
| `project-owner`, `project-number` | | Single-project alternative to `projects` |
| `project-owner-type` | auto | `organization` or `user`, for `project-owner`/`project-number` only |
| `repositories` | | Comma/newline-separated `owner/repo` list to scan for issues |
| `include-labels` | | Keep only cards with at least one of these labels (case-insensitive) |
| `include-assignees` | | Keep only cards assigned to at least one of these GitHub logins (case-insensitive) |
| `exclude-labels` | | Drop cards with any of these labels (wins over include) |
| `date-field-names` | `Due Date, Due, Target Date, Date, End Date` | Field names treated as the due/target date |
| `start-date-field-names` | `Start Date, Start` | Field names treated as the start date |
| `issue-body-due-regex` | built-in | Regex for due dates in issue bodies |
| `issue-body-start-regex` | built-in | Regex for start dates in issue bodies |
| `include-closed` | `false` | Include closed issues and done cards, shown with a `✓` title prefix |
| `closed-status-values` | `Done, Closed, Completed, Finished` | Project `Status` values that mean a card is done |
| `include-description` | `true` | Put issue/card bodies (first 1000 characters) in event descriptions |
| `fail-on-error` | `false` | Fail the run when a repo or project can't be fetched, instead of publishing partial data |
| `output-file` | `calendar.ics` | Where to write the feed |
| `calendar-name` | `GitHub Issues & Projects Calendar` | Calendar title |
| `calendar-description` | `Calendar feed synchronized from GitHub Issues and Project cards` | Calendar description |

### Outputs

| Output | Description |
| :--- | :--- |
| `ics-path` | Absolute path of the generated `.ics` |
| `events-count` | Number of events in the feed |

### Files written

Next to `output-file` the action also writes `.nojekyll` and `index.html` (the landing page). The landing page is regenerated on every run unless you replaced it with your own page (generated pages carry a marker comment). The `.ics` itself is only rewritten when its content changed.

### Event identity

Events use stable UIDs (`gh-issue-<owner>-<repo>-<number>@github.com` for issues and pull requests, a project-item ID for draft cards) so calendar apps update events instead of duplicating them when dates change or a card moves between projects.

---

## Troubleshooting

| Symptom | Likely cause |
| :--- | :--- |
| 0 events | Check the field names (`date-field-names` must match your *Target date* field, case-insensitive), that cards are not closed (`include-closed`), and that `include-labels` isn't excluding everything. |
| Events missing for some repos/projects | Token lacks access. Set `fail-on-error: true` to make this fail loudly. |
| "Projects v2 not found" | Wrong `owner/number`, or the PAT cannot see the project. |
| Wrong day for milestone dates | Milestone `due_on` is a timestamp; the action uses its date part. Prefer a *Target date* field. |
| New dates take a day to appear in Google Calendar | Google's own refresh interval; see the note in Step 3. |

---

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # bundles and runs tests/verify.js
npm run build       # bundles src/index.ts to dist/index.js
```

`dist/index.js` is what the action actually runs, so **commit it** after changing anything in `src/`. CI rebuilds it and fails if the committed copy is out of date. Tests use Node's built-in test runner (`node:test`).

Input defaults live in `action.yml` and, as fallbacks for empty values, in `src/defaults.ts`; a test fails if the two drift apart.

### Releasing

Push a tag such as `v1.0.1`. The release workflow runs the tests, verifies `dist`, creates a GitHub release and moves the major tag (`v1`) to the new version.

Layout:

| File | Responsibility |
| :--- | :--- |
| `src/index.ts` | Reads inputs, orchestrates, writes output files |
| `src/projects.ts` | Projects v2 GraphQL (project fields and issue fields) |
| `src/issues.ts` | Repository issue scan |
| `src/dates.ts` | Date parsing/extraction and iCal date formatting |
| `src/filters.ts` | Include/exclude label and assignee filters |
| `src/defaults.ts` | Fallback values for inputs left empty |
| `src/description.ts` | Event description helpers |
| `src/retry.ts` | Retries transient GitHub API failures |
| `src/merge.ts` | De-duplication across sources |
| `src/project-refs.ts` | Parses the `projects` input |
| `src/ical.ts` | RFC 5545 generation and line folding |
| `src/landing.ts` | GitHub Pages landing page |

---

## License

MIT
