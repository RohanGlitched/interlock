---
name: interlock
description: Prove properties of Jira workflows with the Interlock MCP server before changing or relying on them. Use when asked whether a Jira workflow can strand work, finish work without a resolution, reopen work while it stays resolved, or let work skip a required status such as review, and before editing a workflow's transitions.
license: MIT
---

# Interlock: proofs about Jira workflows

Interlock is an Atlassian Forge app with an MCP server at `https://mcp.atlassian.com/forge/<interlock-app-id>`
(a Jira admin enables it under Admin > Apps > Connected apps). It model-checks workflows: every reachable
state, not a sample.

## Tools
- `check-workflows` (optional `projectKey`): every workflow with findings, each with the shortest bad route.
- `get-workflow-findings` (`workflow`): properties that hold and every finding for one workflow.
- `prove-route` (`workflow`, `target`, `through`): proves that every route to `target` passes `through`,
  or returns a counterexample route.

## How to use the results
1. Before changing a workflow, call `get-workflow-findings` and keep the list.
2. After the change, call it again and compare. A new finding means the change broke a property.
3. For review or compliance rules ("nothing reaches Done without Code Review"), use `prove-route` and
   quote its answer.
4. Report routes exactly as returned. Do not infer routes yourself.
5. A "Done but unresolved" finding can be harmless when a board column or an automation rule sets the
   resolution. Ask the user to replay the route from the Interlock page in Jira, which runs it on a real
   work item and shows what Jira actually does.
