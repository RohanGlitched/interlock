![Interlock: proves what your Jira workflows can actually do](docs/cover.png)

# Interlock

A Jira workflow is a small program. Teams rely on it for promises such as *"nothing is done without code review"*, *"done work is resolved"* and *"nothing gets stuck"*, and Jira itself never checks those promises. A global transition added for a hotfix, a status copied from another project, or a transition screen without the Resolution field quietly breaks them. Dashboards then count finished work as unresolved, or reopened work as resolved, and release reports are wrong.

Railway signal boxes solved this a century ago with interlocking: the frame physically prevents a lever combination that would set conflicting routes. Interlock brings the same idea to Jira. Instead of testing a few example tickets, it works through every situation a work item can ever be in, meaning each status combined with whether the resolution is set, and checks each promise against all of them. That kind of exhaustive check is called model checking.

It is for Jira administrators and the teams who rely on Jira's numbers: service desks reporting SLAs and change volumes, software teams with review rules, anyone whose release report counts resolved work.

## What it finds

| Property | What it means |
|---|---|
| Work can get stuck | some reachable status has no route to any done status |
| Done but unresolved | a route reaches a done status without setting a resolution, so the work still counts as unresolved |
| Reopened but still resolved | a route leaves a done status without clearing the resolution |
| Status nobody can reach | no route from creation leads to it |
| Transition nobody can use | its conditions allow no user, role, group or permission |
| Route skips a required status | your rule, such as *"work reaches Done only through Code Review"*, does not hold |

Each finding comes with the shortest route that breaks the property, from creation, transition by transition.

13 of those 29 are copies of Jira Service Management template workflows; the Change Management copy appears in six projects with the same five findings, and one was confirmed on a real work item: a declined change sent back to Review stays resolved as Declined. A project created from the same template today does not have that route, so these copies come from an earlier version of the template or were edited after they were made. Either way, nothing in Jira tells an admin which workflows still carry such routes; Interlock does. The full list is in [Resolution defects in template-made workflows](docs/atlassian-templates.md).

## Evidence, in three steps

A proof says what *can* happen. Interlock then takes each finding as far as it can go:

1. **Proved.** The model checker found the route.
2. **In your data.** For resolution findings, Interlock counts the work items in the projects using that workflow that are already in the bad state, using Jira's own search. On an Atlassian demo site on Nov 1, 2026, before we added anything, 29 of its 97 workflows had routes that go wrong and 78 work items in its sample projects were already in a wrong state.
3. **Replayed.** One click creates a new work item and walks it down the route through Jira's transitions API, filling in each transition screen the way a person would. It reads back the status and resolution after every step, and once more a few seconds after the last one, so an automation rule that repairs the resolution shows up and the route is reported safe.

Then **fix at the cause**: for resolution findings, Interlock adds *Set resolution* or *Clear resolution* to the transitions involved. Jira validates the change first, and Interlock saves it only when an admin clicks Apply. The whole site is then proved again.

## In Jira

**The Interlock page** (Apps → Interlock) is a signal-box mimic panel:

- The lever frame lists every workflow, worst first, with its findings and the work items already affected.
- The track diagram draws the selected workflow. A lit train runs along the bad route.
- The interlocking table lists the findings with their routes, evidence lamps, replay and fix.
- You can write a rule ("work reaches Done only through Code Review") and Interlock proves or refutes it over every route at once, in the browser.

On a site with no software project, **Add the Ship demo project** builds a seeded demo: a delivery workflow with the shortcuts teams add over time, and 20 tickets moved along real routes. Half of its 12 done tickets end up unresolved, and the rule *Done only through Code Review* is refuted with the exact route. The demo shows the mechanics; the evidence from real configurations is the [template report](docs/atlassian-templates.md).

**The daily watch** proves every workflow again once a day and compares each proof with the one before, so a workflow edit that opens a bad route shows up as a new finding with the date it appeared.

**Rovo.** The *Workflow interlock* agent answers questions such as *"Can work in Change Management reach Completed without passing Review?"* with a proof or a counterexample route. The same three tools (`check-workflows`, `get-workflow-findings`, `prove-route`) are published as an MCP server, so a coding agent can prove a workflow before and after changing it. [`skills/interlock/SKILL.md`](skills/interlock/SKILL.md) tells an agent how to use them.

## How it works

- `engine/interlock.mjs` builds a model from `GET /rest/api/3/workflows/search` with transitions expanded:
  - statuses with their categories;
  - directed and global transitions;
  - each transition's effect on the resolution, from its rules and from whether its transition screen includes the Resolution field;
  - whether its conditions let anyone use it.
- A breadth-first search over (status, resolution set) states finds every reachable state, with parent links, so every finding comes with its shortest route.
- Team-managed projects keep the resolution in step with done statuses themselves, and the model knows that.
- Checking all 97 workflows on that demo site, 761 transitions in all, takes about 100 ms once the configuration is loaded. Loading it over the REST API takes 10 to 20 seconds the first time on a site that size; later checks reuse the transition-screen answers for 10 minutes and take about half as long. The engine is plain JavaScript with no dependencies, and the page runs it again in the browser whenever you change a rule.

## Permissions

Interlock is for Jira administrators, because workflows are site configuration.

| Scope | Why |
|---|---|
| `manage:jira-configuration` | read workflows and statuses; validate and apply a fix |
| `manage:jira-project` | read transition screens (to see which ones set the resolution) and workflow schemes; create the demo project |
| `read:jira-work` | count work items already in a bad state; read transitions during a replay |
| `write:jira-work` | create and move the replay work item and the demo tickets |
| `read:jira-user` | read the current user when building the demo project |

Interlock changes a workflow only when an admin clicks **Apply** on a fix that Jira has already validated.

## For judges

Install Interlock from the link on the Devpost page, as a Jira administrator (workflows are site configuration, so the page is shown to admins only). Then:

1. Open **Apps → Interlock**. It reads and proves every workflow on the site; the lever frame on the left lists the ones with findings, worst first. On a site whose projects were made from older templates you may see findings like those in the [template report](docs/atlassian-templates.md); a brand-new site is likely to be clean, so use the Ship demo to see every feature.
2. Select a workflow, then a finding. The track diagram lights the bad route and a train runs along it. The lamps show how far the finding is proven: proved, seen in your data, replayed.
3. Select **Replay on a new work item**. Interlock walks a new work item down the route through Jira and reads back the status and resolution after each step. Delete the item afterwards with the button next to it.
4. On a resolution finding, select **Check the fix with Jira**, then **Apply**. The site is proved again and the lamp turns green. **Undo** puts the workflow back.
5. Under **Rules for this workflow**, prove a rule such as *work reaches Done only through Code Review*. On a site without a software project, **Add the Ship demo project** first.
6. In Rovo, ask the *Workflow interlock* agent *"Can work in Change Management reach Completed without passing Review?"*

## Build and deploy

```bash
npm install
cd static/panel && npm install && npm run build && cd ../..
forge deploy
forge install
```

`npm run dev` in `static/panel` runs the page in a plain browser against a saved copy of a site's workflows.

## Layout

```
manifest.yml            global page, Rovo agent, actions, MCP server
engine/interlock.mjs    the model checker
src/index.js            site loading, live counts, replay, fix, demo project, Rovo actions
static/panel/src/       the signal-box page (React): layout, track diagram, interlocking table
skills/interlock/       agent skill for the MCP server
```
