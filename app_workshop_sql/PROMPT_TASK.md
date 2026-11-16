You are working inside an existing codebase.

Inputs and reference files:
- Agent rules: `AGENTS.md`
- Architectural considerations: `docs/architectute/`
- Testing rules: use the skill bdd-gherkin-feature-writer
- Tech stack: `specs/tech_stack.md`
- API conventions: `docs/architectute/`
- things learned: `learned.md`s
- errors learned in order to avoid them : `error_memories.md`
- data models folder: `docs/sql_data_model`


Critical constraints:
- Always follow `AGENTS.md`.
- Do not invent or modify the data model unless explicitly required by the existing project instructions.
- Do not fake test success.
- Do not create shallow or brittle step definitions just to make tests pass.
- Implement only things needed. Do not implement things out of scope or out of the need
- responses should always follow docs/architecture/ADR-003-standardized-api-response-format.md
- add also at least 3 tests using skill 'bdd-gherkin-feature-writer' found in .claude/skills/bdd-gherkin-feature-writer
- If you find any logical errors, or possible bugs, conflicts, edge cases, or inconsistencies, let me know and suggest a fix or change.
- If you create or update API endpoints always update the json schema

Your task is:


<task>
</task>
