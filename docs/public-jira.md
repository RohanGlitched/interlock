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

Each of these items is counted wrongly by any filter, dashboard or report that relies on the resolution, unless the site has worked around it. OpenJDK shows it does not have to be this way: a well-kept set of workflows gets both numbers to zero.

## The defects cluster in a few projects

| Site | Project | Items | State |
|---|---|---|---|
| Atlassian | SRCTREE (Sourcetree) | 1,065 | Closed with no resolution |
| Apache | MADLIB | 675 | Closed or Resolved with no resolution |
| Apache | HUDI | 348 | Resolved or Closed with no resolution |
| Apache | MXNET | 333 | Done with no resolution |
| Apache | LUCENE | 380 | Reopened or Patch Available, still resolved |
| Apache | BEAM | 698 | Open or Triage Needed, still resolved |

## How they got there, from the items' public history

Every item's change history is public, so we read it the way Interlock's "How did they get there?" does: the last status change on each item is the step that put it where it is. We read all of them (Nov 2, 2026) and also noted who made each step, because a step made by a person through a transition is a workflow route, while a step with no author is a system change such as a migration or a bulk script.

**Apache, done but unresolved (1,844 items).** 764 have a status change in their history; the other 1,080 were created or imported already in that state, so no transition is to blame for them (MADLIB's 675 are almost all among them: 672 have no status change). Of the 764, **759 were moved there by people: 114 different people on 348 different days**, through ordinary transitions that never set a resolution. The largest:

| Project and step | Items | Example |
|---|---|---|
| MXNET In Review → Done | 204 | [MXNET-1447](https://issues.apache.org/jira/browse/MXNET-1447): To Do → In Progress → In Review → Done, no resolution at any step |
| HUDI Open → Resolved | 155 | [HUDI-9748](https://issues.apache.org/jira/browse/HUDI-9748): resolved in August 2025, resolution empty |
| MXNET In Progress → Done | 129 | |
| HUDI Patch Available → Closed | 74 | |
| HUDI Patch Available → Resolved | 40 | |
| HUDI Resolved → Closed | 35 | |
| SDAP To Do → WontFix | 33 | |

This is the pattern Interlock proves from configuration: a transition into a done status that does not set a resolution, used by many people for years, each use adding one more miscounted item.

**Apache, open but still resolved (1,239 items).** This side is mostly not routes: 1,100 of the last steps have no author (BEAM's 637 "Resolved → Triage Needed" and Lucene's 379 are system changes after both projects moved to GitHub Issues in 2022), and 29 items have no status change. The rest were people, and the clearest route among them is the classic one: **a reopen from Closed that keeps the old resolution**, 25 times in GEODE ([GEODE-9489](https://issues.apache.org/jira/browse/GEODE-9489)) and 14 in IGNITE ([IGNITE-7537](https://issues.apache.org/jira/browse/IGNITE-7537)), by 31 different people.

**Not every count is a route.** Two clusters on the other sites turned out to be one-off operations, and we say so rather than count them as evidence:

- **Sourcetree (1,065):** every item was closed by one person on one day (September 19, 2019) through Resolved → Closed, after the project moved to another workflow. It is a single bulk close through a transition that does not set a resolution: the same defect, but one event.
- **Lucene (380, open but still resolved):** 379 of the last steps have no author; 367 happened in 2024, after Lucene moved to GitHub Issues in 2022. These are system changes, not people using the workflow.

These counts were read on Nov 2, 2026 with `prover/tools/public-trace.mjs` (below) and change as the sites change.

## Limits

- Interlock's proof needs a site administrator, because it reads workflow configuration. We are not administrators of these sites, so this page shows the symptoms Interlock counts and the routes visible in public history, not a proof over their workflows.
- Some counts have other causes than a workflow route: imports (Apache's 1,080 with no status change), bulk operations (Sourcetree) and migrations (Lucene and BEAM moved to GitHub Issues in 2022). The section above separates the ones we could check; we did not trace the open-but-resolved side beyond Lucene.
- The counts change daily; to rerun them, see below.

## Reproduce it

```bash
curl -s -G "https://issues.apache.org/jira/rest/api/2/search" \
  --data-urlencode "jql=statusCategory = Done AND resolution is EMPTY" --data-urlencode "maxResults=0"
```

Change the host and the query for the other rows, and add `AND project = HUDI` to narrow to one project. To read how the items got there, with who made each step:

```bash
node prover/tools/public-trace.mjs issues.apache.org/jira "statusCategory = Done AND resolution is EMPTY" 1900
```

It only reads public search results, 50 items at a time.
