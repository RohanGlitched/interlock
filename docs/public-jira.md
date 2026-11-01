# Resolution defects on public Jira sites

Interlock proves which workflow routes leave the resolution wrong, then counts the work items already in that state. The counting needs nothing but Jira's own search, so it can be run on any Jira site that lets the public search. We ran it on Nov 1, 2026, on four large public sites, with the same two queries Interlock uses:

- done but unresolved: `statusCategory = Done AND resolution is EMPTY`
- open but still resolved: `statusCategory != Done AND resolution is not EMPTY`

| Public Jira site | Done but unresolved | Open but still resolved |
|---|---|---|
| Apache Software Foundation (issues.apache.org/jira) | **1,844** of 995,795 done | **1,239** of 190,063 open |
| Atlassian's public tracker (jira.atlassian.com) | **1,092** of 288,414 done | 9 of 72,720 open |
| MongoDB (jira.mongodb.org) | 30 of 189,701 done | 3 of 25,109 open |
| OpenJDK (bugs.openjdk.org) | **0** of 362,655 done | **0** of 23,017 open |

Every one of these items is miscounted by the site's own filters, dashboards and reports. OpenJDK shows it does not have to be this way: a well-kept set of workflows gets both numbers to zero.

## The defects cluster in a few projects

That is the signature of a workflow problem rather than of people making mistakes one item at a time:

| Site | Project | Items | State |
|---|---|---|---|
| Atlassian | SRCTREE (Sourcetree) | 1,065 | Closed with no resolution |
| Apache | MADLIB | 675 | Closed or Resolved with no resolution |
| Apache | HUDI | 348 | Resolved or Closed with no resolution |
| Apache | MXNET | 333 | Done with no resolution |
| Apache | LUCENE | 380 | Reopened or Patch Available, still resolved |
| Apache | BEAM | 698 | Open or Triage Needed, still resolved |

## Two routes, from the items' public history

Each item's change history is public, so the route it took can be read back, transition by transition. These are the routes Interlock proves from a workflow's configuration:

- **LUCENE-10659, reopened but still resolved.** Open → Resolved (resolution Fixed) → Reopened (resolution cleared) → Resolved (Fixed) → Closed → **Reopened, resolution still Fixed** (2024-10-10). The reopen from Resolved clears the resolution; the reopen from Closed does not. The issue is open, and every report counts it as fixed.
- **SRCTREE-6859, done but unresolved.** Open → Resolved → Closed, and no transition ever set a resolution. The issue is closed, and every report counts it as unresolved.

## Limits

- Interlock's proof needs a site administrator, because it reads workflow configuration. We are not administrators of these sites, so this page shows the symptoms Interlock counts and the routes visible in public history, not a proof over their workflows.
- Some counts may have other causes than a workflow route: bulk edits, imports, or a project migrating to another tracker (Apache BEAM moved to GitHub Issues in 2022, for example). The history of each item says which.
- The counts change daily; to rerun them, see below.

## Reproduce it

```bash
curl -s -G "https://issues.apache.org/jira/rest/api/2/search" \
  --data-urlencode "jql=statusCategory = Done AND resolution is EMPTY" --data-urlencode "maxResults=0"
```

Change the host and the query for the other rows; add `AND project = LUCENE` to narrow to one project, and read an item's route with `/rest/api/2/issue/LUCENE-10659?expand=changelog`.
