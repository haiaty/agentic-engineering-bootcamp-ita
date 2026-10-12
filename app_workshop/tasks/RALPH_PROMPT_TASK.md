You are working inside an existing codebase which is located in app_workshop/.

You are implementing a SINGLE standalone task (a feature or a refactor) that is NOT part of a user story.
There is no user_stories.toml entry, no feature decomposition and no per-scenario workflow for this task.

Inputs and reference files:
- Task description: the `TASK.md` file referenced in the workflow prompt (specs/tasks/<slug>/TASK.md)
- Implementation plan: the `plan.md` file next to `TASK.md` (written by the plan step)
- Progress log to know what has been done and how to resume: `progress.txt`
- Agent rules: `AGENTS.md`
- Architectural considerations: `docs/architecture`
- Testing rules: use the skill bdd-gherkin-feature-writer
- Tech stack: `specs/tech_stack.md`
- API conventions: `specs/api_rules.md`
- things learned: `learned.md`
- errors learned in order to avoid them: `error_memories.md`
- data models folder: docs/sql_data_model/

Critical constraints:
- Always follow `AGENTS.md`.
- Stay strictly within the scope described in `TASK.md`. Do not implement things out of scope.
- Do not invent or modify the data model unless the task explicitly requires it.
- Do not fake test success. Do not weaken, skip or delete existing tests to make them pass.
- Implement real, robust behavior. Reuse existing project patterns and respect the existing architecture.
- Prefer small, verifiable changes.

If the task is a REFACTOR:
- Observable behavior must not change (API contracts, responses, error codes, persisted data, audit records).
- The existing tests are the specification: if they fail after the refactor, fix the code, not the tests.
- Point out in the plan any touched area that has no test coverage.

If the task is a FEATURE:
- Write the tests that cover the new behavior (unit tests and/or BDD scenarios).
- BDD scenarios must be tagged `@done` so they are included in the regression run.
- Assert database changes and audit table values in the BDD steps when the feature writes data.

Tests:
- Before running BDD tests, reload the server with: npm run reload:dev
- Regression run: npm run test:tag @done
- The workflow runs the regression suite in a dedicated step: do not run it during the plan or implement steps.
- To debug failures use the skill .claude/skills/agentic-debug

Progress reporting:
- At every step, print what you are doing to `progress.txt` (e.g. "Planning task", "Implementing refactor", "Fixing regression").

Memory:
- append errors and issues that you got in 'error_memories.md'.
- append caveats and important things that you learned in 'learned.md'
