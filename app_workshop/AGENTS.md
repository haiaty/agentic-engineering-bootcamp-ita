# Global Rules

This is a Nodejs project.

- YOU MUST use the luminous architecture described in 'LUMINOUS_ARCHITECTURE.md' VERY IMPORTANT!
- **No shared state** - No global state, No $this - Everything must be passed via function/method parameters.
- Avoid instances when possible (prefer static classes in OOP languages).
- No framework code inside `/src`.
- All files must use LF (unix) line separator
- Do not set defaults in case a key or value is not present, for example do not do set defaults like this: payload.created_by || 1
- Do not commit your changes. Human will review them before commit


# Code comments
- You must comment each line of code and separate related code using a block like this:

```text
//=====================
// <main comment headline>
// <code explanation>
// <why this code>
//======================
```
So in the comment, you must give a clear explanation of what
the code (or the code block) is doing and why, constraints, invariants, and non-obvious decisions.
Don't comment on self explanatory things.
Don't add comments that don't add value.



# NodeJS

- Always use CommonJs, not ES modules
- Always add 'use strict'
- use this pattern to require files
- Node.js built-in modules should be imported using the "node:" protocol
- Always do module requires in the root of module, not inside functions. DO NOT do require inside functions.

```
const path = require("node:path");

const ExampleJob = require(path.resolve(process.cwd(), "src", "jobs", "Example"));
const TransformStringToArrayJob = require(path.resolve(process.cwd(), "src", "jobs", "TransformStringToArray"));
```

- use Number() to convert to numbers.


# Testing

- use the skill for testing under `.claude/skills/bdd-gherkin-feature-writer/SKILL.md`
- if the code saves data on db or if the code saves data to the audit log table, write a step on the scenario.

# Fastify API rules

- always put the endpoint defintion in 'server/constants.js' and use the costants on the routes
- always put the schema validation on every route using this code as example:
```
let inputsForJsonSchemaFactory = {
                route: PATHS.enrollment,
                method: "post",
                schemaAbsolutePath: path.resolve(process.cwd(), "server", "openapi", "schema.json"),
};

const openApiJsonSchemaForRoute = await openapi.fastifySchemaFactoryV2(inputsForJsonSchemaFactory);

fastifyInstance.post(PATHS.enrollment, { "schema": openApiJsonSchemaForRoute}, async function enrollmentHandler(request, reply) {
});
....
```