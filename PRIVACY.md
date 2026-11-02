# Interlock privacy policy

Last updated: November 2, 2026

Interlock is an Atlassian Forge app. It runs on Atlassian's own infrastructure ("Runs on Atlassian"). It has no backend of its own, makes no calls outside Atlassian, and uses no AI service, analytics or tracking.

## What Interlock reads

Interlock reads your site's workflow configuration: workflows, statuses, transitions, transition screens, workflow schemes and the list of projects. It reads them through Jira's REST API as the Jira administrator who opens it. The daily watch reads them as the app.

To count the work items already in a bad state, Interlock runs Jira searches that return counts, not content. "How did they get there?" reads the status history of up to 50 of those work items.

## What Interlock stores

Interlock keeps its records in Forge app storage. That storage belongs to your Jira site and is kept in Atlassian's cloud. Only Interlock can read it. The records are:

- **Workflow rules your admins save** ("Done only through Code Review").
- **Findings an admin recorded as intended,** with who recorded them (Jira account ID and display name), when and why.
- **Each fix applied through Interlock,** with the transitions' actions before and after, so it can be undone.
- **The daily watch:**
  - the last proof's findings (workflow names, statuses and the problem found);
  - a short history of what appeared or was fixed;
  - the project chosen for its reports, and which findings were reported.
- **Answers about which transition screens ask for a resolution,** cached for up to 30 minutes.
- **The work items created by a replay,** so they can be deleted again.

Interlock changes your site only when an admin asks it to:
- a fix the admin applies (and its Undo);
- a replay work item;
- the Ship demo project;
- the daily work item listing new findings, in the project an admin picked.

## What Interlock does not do

- It sends no data outside Atlassian.
- It uses no cookies, analytics or third-party services.
- It does not sell or share data.

## Retention and deletion

Every stored record is overwritten or trimmed as new proofs run. The watch history keeps about the last 60 changes.

When Interlock is uninstalled, Forge removes all of its app storage.

Work items, projects and workflow changes made at an admin's request are ordinary Jira content. They stay until someone removes them in Jira; replay work items can be deleted from Interlock.

## Contact

Questions or requests: open an issue at https://github.com/RohanGlitched/interlock/issues.
