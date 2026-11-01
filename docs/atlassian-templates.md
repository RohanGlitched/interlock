# Resolution defects in template-made workflows

We ran Interlock on an Atlassian demo site on Nov 1, 2026, before we added anything to it. The site came with sample projects made from Jira's own templates: IT service management, HR, facilities, legal, marketing, procurement, design and security operations.

Interlock checked 97 workflows and 761 transitions. **29 workflows have routes that leave the resolution wrong**, and **78 work items in the sample projects were already in that wrong state.**

**13 of the 29 are copies of Jira Service Management's template workflows**, named as Jira names them ("Change Management workflow for Jira Service Management"). The Change Management workflow has six copies (five in use: ENGS, INV, ITO, ITS, SECOPS) with the same five findings. The other 16 are business-template and sample workflows that came with the demo site.

### Is it the template itself? We checked: today's template is clean

To find out, we created a new IT service management project (TPL) from Jira's template on the same site on Nov 1, 2026, and proved its six new workflows. **None has a finding.** Comparing the two Change Management workflows shows why: the six older copies have a "Back to review" transition out of Declined that keeps the resolution, and "Mark as canceled" transitions; today's template has neither (it uses "Cancel", and Declined has no way back).

So the defect is in projects made from an earlier version of the template, or edited since. That is the real lesson for admins: **a fix to a template never reaches the projects already made from it**, and nothing in Jira tells you which of your workflows still carry the old routes. Interlock does, and it proves each one.

The work-item counts come from the site's seeded sample data, so they show that these routes are used, not how often real teams hit them.

## What goes wrong

Jira decides whether work is finished by its **resolution**, not its status. Filters, dashboards, "Created vs resolved" charts, SLAs and release reports all count unresolved work as open. Two things break that:

- **Done but unresolved:** a route reaches a done status without setting a resolution, so finished work keeps counting as open.
- **Reopened but still resolved:** a route takes work out of a done status without clearing the resolution, so open work counts as finished and keeps its old resolved date.

## Workflows made from Jira Service Management templates, with findings

| Template workflow | Projects on the demo site using a copy | Finding | Statuses affected |
|---|---|---|---|
| Change Management workflow for Jira Service Management | ENGS, INV, ITO, ITS, SECOPS (and an unused copy, OMI1121) | Reopened but still resolved | Review, Planning, Authorize, Awaiting implementation, Implementing |
| Post-Incident Review workflow for Jira Service Management | ENGS, SECOPS (and OMI1121) | Reopened but still resolved | Draft, Awaiting approval |
| Service Request Fulfilment with Approvals workflow | HR | Reopened but still resolved | 6 statuses, including In Progress and Waiting for customer |
| Simple ESM workflow for Jira Service Management | HR | Reopened but still resolved | SME Support Required, In Progress |
| Default workflow for Customer Service Management | TALLY | Reopened but still resolved | In Progress, Escalated, Waiting for customer |
| Incident Management workflow for Jira Service Management | SECOPS | Done but unresolved | Completed, Closed |

## Other workflows on the demo site with findings

These came with the demo site's sample projects (business templates and sample content). Their findings are real for this site; they are listed for completeness, not as product defects.

| Workflow | Projects | Finding | Statuses affected |
|---|---|---|---|
| Multilevel Approvals | ITO, ITS | Done but unresolved | 1 done status |
| Onboarding, Offboarding (HR) | HR | Done but unresolved, Reopened but still resolved | 2 and 1 statuses |
| Procurement Workflow, Procurement Workflow v2 | PROC | Done but unresolved | Purchased, Rejected |
| Content Management Workflow, v2 | MC | Done but unresolved | 1 done status |
| Document Approval Workflow, v2, and a copy of v2 | none (LGL's three copies are not in use) | Done but unresolved | 1 done status |
| Web design process task and sub-task workflows | DESIGN | Done but unresolved | Launch |
| Bug Intake, NIST Workflow, Simple Inventory Example | ENGS, SECOPS, FAC | Done but unresolved | 1 done status each |

## Approvals that can be skipped

Interlock also checks a workflow's approval steps (the statuses where Jira Service Management asks named approvers to approve). In a workflow that has one, every route to a successful outcome should pass it. On the demo site:

| Workflow | Projects | Route that skips the approval |
|---|---|---|
| Change Management workflow for Jira Service Management | ENGS (and OMI1121) | **Mark as done** takes a change straight to Completed without passing Authorize |
| Post-Incident Review workflow for Jira Service Management | ENGS, SECOPS (and OMI1121) | Draft → **Mark as published** reaches Published (and then Closed) without passing Awaiting approval |

Interlock replayed the first one on a real work item: **ENGS-30 was created in Review and went straight to Completed via "Mark as done", resolved as Done, with no approval asked for.**

Whether a shortcut like "Mark as done" is acceptable is a policy decision (standard changes are often pre-approved), but it should be a decision someone made, not a route nobody knew about.

## Confirmed on real work items, not just in the model

A proof says a route exists. Interlock then replays the route through Jira's own transitions API on a new work item, filling in each transition screen the way a person would, and reads back the status and resolution after every step.

- **Change Management (ITS):** a change request is created in Review, declined (the Decline screen asks for a resolution and the replay chose Declined, as a person would), then sent "Back to review". **ITS-6267 ended up open in Review and still resolved as Declined**, and it was unchanged when Interlock looked again a few seconds later (an automation rule on a slower schedule could still change it; none did while we watched). Any change request that is declined and then reconsidered counts as resolved: it drops out of every filter, report and SLA that looks for unresolved changes.
- **Procurement (PROC):** "Demo Fast Track" takes a request to Purchased with no resolution. PROC-126 confirmed it. On the demo site, **72 of the 109 done procurement requests were unresolved** (73 of 110 after our replay, PROC-126, reached Purchased the same way), so every report counted them as still open. We then applied Interlock's fix to the PROC v2 workflow (Purchased now sets a resolution on every route into it), so no new request can get there that way. The 72 already there are left to clean up; Interlock now leaves its own replay items out of the count, and its trace shows 46 of the 50 most recently changed requests came Accepted → Purchased before the fix.
- **Web design (DESIGN):** 1 of 1 launched task was unresolved.

## The fix

Each finding is fixed at the cause, on the transition that creates the wrong state:

- add "Set resolution" to transitions into a done status, unless the transition screen already asks the person for one;
- add "Clear resolution" to transitions that take work out of a done status.

Interlock proposes exactly these changes, has Jira validate them before saving, applies them only when an admin clicks Apply, proves the whole site again, and can undo them. Work items already in the wrong state need a one-time bulk change; Interlock links to the search that finds them.

## Reproduce it

Install Interlock on any Jira Cloud site created from these templates and open Apps → Interlock. The engine is open source in `engine/interlock.mjs`, and the list above comes from the proof the app records on every check.
