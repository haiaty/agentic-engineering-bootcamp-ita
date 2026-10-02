You are working inside an existing codebase.


Inputs and reference files:
- Progress log to know what has been done and how to resume: `progress.txt`
- Agent rules: `AGENTS.md`
- Architectural considerations: `docs/architectute`
- Testing rules: use the skill bdd-gherkin-feature-writer
- Tech stack: `specs/tech_stack.md`
- API conventions: `specs/api_rules.md`
- things learned: `learned.md`
- errors learned in order to avoid them : `error_memories.md`
  data models folder: docs/sql_data_model/

Critical constraints:
- Always follow the implementation workflow. do not change steps order.
- Always follow `AGENTS.md`.
- Do not invent or modify the data model unless explicitly required by the existing project instructions.
- Do not fake test success.
- Do not create shallow or brittle step definitions just to make tests pass.
- Implement real, robust behavior.
- Implement only things needed. Do not implement things out of scope or out of the need

Progress reporting:
- At every step of the implementation workflow, print what you are doing to `progress.txt` . For example "Decomposing in features", "Creating gherkin.features", "implementing code", etc..
- Use clear progress markers so the task can be resumed later if the program stops.

Memory:
- append errors and issues that you got in 'error_memories.md'.
- append caveats and important things that you learned in 'learned.md'

Before doing any implementation:
1. Check whether `user_stories.toml` already exists.
2. If `user_stories.toml` does not exist:
    - Create `user_stories.toml`.
    - The file must follow the format described in `<user_stories_toml_format>`.
3. If `user_stories.toml` already exists:
    - Do not recreate it.
    - Read it and preserve its existing content.
    - append this new user story to it
4. Read `progress.txt` if it exists.
5. Determine whether the user story is already in progress.
6. If the user story is in progress, resume from the last completed step recorded in `progress.txt`.
7. If the user story is not in progress, start it and mark the 'in_progress = true'

Implementation workflow:

For the selected user story:

1. Mark the user story as `in_progress` in `user_stories.toml`.

2. Decompose the user story into implementation features. Split in more than one feature if the user story is big.
    - Create a folder named `specs/user_story_x`, where `x` is the user story number padded with 3 digits.
    - Create a file called `specs/user_story_x/shared_across_features.md` in which you will put the shared rules or knowledge across all features. If it already exists skip this step
    - Create one feature specification file per feature inside that folder. The name format should be 'feature_x' where x is the feature number. If already exists a file called 'feature_x' just skip the feature creation step (next step)
    - Each feature specification file must follow the structure described in `<feature_template>`.

3. For each feature, in order:

   a. Create a Gherkin `.feature` file inside `tests/features`.
    - create max 3 scenarios
    - use the skill bdd-gherkin-feature-writer
    - You must write steps to assert database values changes 
    - You must insert steps to verify values in audit table
    - add the tag @USXXX-scenario-y to scenario where x is the number of the user story padded to 3 digits and y the number of scenario, so if the user story is 014 and it's the first scenario the tag must be @US014-scenario-1

   b. For each scenario in the `.feature` file:

   i. Implement the production code required to satisfy the scenario.
    - Follow `AGENTS.md`.
    - Reuse existing project patterns.
    - Respect the existing architecture.
    - Use the existing data model defined in `docs/sql_data_model/` if one exists.
    - At this step do not run tests

   ii. Implement the step definitions required for the scenario.
    - use the skill bdd-gherkin-feature-writer
    - Make the step definitions robust and maintainable.
    - Do not bypass the real application logic.

   iii. Run only the test for the scenario just implemented. 
        Before running tests, reload the server with the shell command: npm run reload:dev
        Run the test with this command "npm run test:tag @USXXX" where @USXXX must be replaced with the user story, so for example if the user story is 14 it should be replaced with @US014

   iv. If the test fails:
    - Diagnose the failure and fix it using the skill .claude/skills/agentic-debug 
    - Fix the implementation or step definitions.
    - Re-run the same scenario.
    - Continue until the scenario passes.

   c. After all scenarios for the feature pass, move to the next step
   d. Develop and run unit tests for the jobs and operations
   i.  If unit the test fails:
   - Diagnose the failure (see DEBUG_RULEs.md in order to know how to proced debugging and fixing).
   - Fix the implementation or step definitions.
   e. After all tests passes: Mark the feature as done 'done=true' and in_progress=false


4. After all features for the selected user story pass:
    - Run the relevant full test suite for the implemented user story.
    - Diagnose the failure and fix it using the skill .claude/skills/agentic-debug
    - Confirm that all tests for the user story pass.
    - Generate or updated the openapi schema.json for the endpoints in `server/schema.json`

5. Mark the user story as `completed` in `user_stories.toml`.

6. Append a final completion entry to `progress.txt`.

7. Print exactly this message to standard output:

   USER STORY FINISHED

8. Stop execution immediately after completing this one user story.
9. EXIT from the command with sucess code

Important behavior:
- Always reference the file of the user story defined in <user_story> while implementing code and tests
- Implement only one user story in this run.
- Do not continue to another user story after finishing this one.
- Resume work if interrupted.
- Prefer small, verifiable changes.
- Keep files organized and consistent with the existing project structure.
- Do not remove existing tests unless they are clearly obsolete and the project rules allow it.
- Do not ignore failing tests related to the selected user story.

<user_stories_toml_format>
[[story]]
id = "US-001"
title = "User login"
done = false
in_progress = false

user_story_source_file=specs/user_stories/user_story_1/USR001.md


</user_stories_toml_format>

<feature_template>
Feature 1: [Feature name]
done: false
in_progress: false

User story As a [actor], I want to [action], so that [benefit].

User flow

[Step 1]
...

Functional requirements

[Requirement 1]
...

Business rules

[Rule 1]
...


API / backend behavior

Endpoint(s): [route or service]

Input: [shape]

Output: [shape]

Error cases: [list]

Permission enforcement: [how]

Acceptance criteria

Given [initial state], when [action], then [observable result].

</feature_template>