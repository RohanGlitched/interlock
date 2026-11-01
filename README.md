![Interlock: proves what your Jira workflows can actually do](docs/cover.png)

# Interlock

A Jira workflow is a small program. Teams rely on it for promises such as *"nothing is done without code review"*, *"done work is resolved"* and *"nothing gets stuck"*, and nobody checks those promises. A global transition added for a hotfix, a status copied from another project, or a transition screen without the Resolution field quietly breaks them. Dashboards then count finished work as unresolved, or reopened work as resolved, and release reports are wrong.

Railway signal boxes solved this a century ago with interlocking: the frame physically prevents a lever combination that would set conflicting routes. Interlock brings the same idea to Jira. It is a model checker. It reads every workflow on the site and explores every state a work item can reach, meaning each status combined with whether the resolution is set. It then checks properties against all of those states, not a sample of them.

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

## Evidence, in three steps

A proof says what *can* happen. Interlock then takes each finding as far as it can go:

1. **Proved.** The model checker found the route.
2. **In your data.** For resolution findings, Interlock counts the work items in the projects using that workflow that are already in the bad state, using Jira's own search. On an Atlassian demo site on Nov 1, 2026, before we added anything, 29 of its 97 workflows had routes that go wrong and 78 work items in its sample projects were already in a wrong state.
3. **Replayed.** One click creates a new work item and walks it down the route through Jira's transitions API. It then reports what Jira actually did, including any board column or automation rule that sets the resolution on the way, which would make the route safe.

Then **fix at the cause**: for resolution findings, Interlock adds *Set resolution* or *Clear resolution* to the transitions involved. Jira validates the change first, and Interlock saves it only when an admin clicks Apply. The whole site is then proved again.

## In Jira

**The Interlock page** (Apps → Interlock) is a signal-box mimic panel:

- The lever frame lists every workflow, worst first, with its findings and the work items already affected.
- The track diagram draws the selected workflow. A lit train runs along the bad route.
- The interlocking table lists the findings with their routes, evidence lamps, replay and fix.
- You can write a rule ("work reaches Done only through Code Review") and Interlock proves or refutes it over every route at once, in the browser.

On a site with no software project, **Add the Ship demo project** builds a realistic delivery workflow with 20 tickets moved along real routes. Half of the 12 done tickets end up unresolved, and the rule *Done only through Code Review* is refuted with the exact route.

**Rovo.** The *Workflow interlock* agent answers questions such as *"Can work in Change Management reach Completed without passing Review?"* with a proof or a counterexample route. The same three tools (`check-workflows`, `get-workflow-findings`, `prove-route`) are published as an MCP server, so a coding agent can prove a workflow before and after changing it. [`skills/interlock/SKILL.md`](skills/interlock/SKILL.md) tells an agent how to use them.

## How it works

- `engine/interlock.mjs` builds a model from `GET /rest/api/3/workflows/search` with transitions expanded:
  - statuses with their categories;
  - directed and global transitions;
  - each transition's effect on the resolution, from its rules and from whether its transition screen includes the Resolution field;
  - whether its conditions let anyone use it.
- A breadth-first search over (status, resolution set) states finds every reachable state, with parent links, so every finding comes with its shortest route.
- Team-managed projects keep the resolution in step with done statuses themselves, and the model knows that.
- Checking all 97 workflows on that demo site, 761 transitions in all, takes about 100 ms once the configuration is loaded (loading it over the REST API takes a few seconds). The engine is plain JavaScript with no dependencies, and the page runs it again in the browser whenever you change a rule.

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
