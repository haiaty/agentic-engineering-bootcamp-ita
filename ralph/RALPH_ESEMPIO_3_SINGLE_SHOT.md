You are working inside an existing codebase.

Inputs and reference files:
- Agent rules: `AGENTS.md`
- Architectural considerations: `docs/architectute/architecture_considerations.md`
- Testing rules: use the skill bdd-gherkin-feature-writer
- Tech stack: `specs/tech_stack.md`
- API conventions: `specs/api_rules.md`
- things learned: `learned.md`s
- errors learned in order to avoid them : `error_memories.md`
- data models folder: `docs/sql_data_model`


Critical constraints:
- Always follow `AGENTS.md`.
- Do not invent or modify the data model unless explicitly required by the existing project instructions.
- Do not fake test success.
- Do not create shallow or brittle step definitions just to make tests pass.
- Implement real, robust behavior.
- Implement only things needed. Do not implement things out of scope or out of the need
- responses should always follow docs/architecture/ADR-003-standardized-api-response-format.md
- add also at least 3 tests using skill 'bdd-gherkin-feature-writer' found in .claude/skills/bdd-gherkin-feature-writer
- If you find any logic erros or possible bugs/conflicts/edge cases/inconsistency advice me and suggest a change 

Your task is:

<task>

Add a feature to trace calls and write to a jsonl file.

I would like something like 

trace("a custom message", { custom_prop: "hello"})

that I can put in my code in order to get a tracing.

Keep it simple
</task>
