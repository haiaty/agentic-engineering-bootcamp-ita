# Luminous Architecture – Guidelines

## Goal

Luminous is an architecture designed to build software that is:

- Easy to understand
- Easy to maintain over time
- Low cognitive load
- Safe to change (no fear when touching the code)
- With technical debt close to zero (and kept there)

Development—whether starting from scratch or maintaining an existing codebase—should not be frustrating. It should be clear, safe, and satisfying. A well-structured project must be easy to pick up again even after months, without confusion or anxiety.

Maintainability is not optional for long-term projects: ignoring it inevitably increases costs over time (time, money, and quality).

You should use this structure both for backend and for frontend code.

---

## Core Principles

Luminous takes inspiration from:

- Lucid Architecture principles
- Functional composition
- Hexagonal architecture
- FaaS (Function as a Service)
- No shared state (no `this` — prefer to pass inputs instead of using `this`, no mutable global state, no singleton stateful only if extremely needed, no hidden side effects)

---

## Non-Negotiable Rules

### Dependency Direction

The dependency direction is strict and unidirectional:

- **services** orchestrate features, operations, jobs, and drivers
- **features** orchestrate operations, jobs, and drivers
- **operations** compose jobs
- **jobs** use drivers when needed
- **drivers** talk to the outside world

No layer may call into the same layer or into a higher layer. This is the most important rule in Luminous.

---

### Jobs

- Must do **one thing only**
- Must have **a single reason to change**
- Must not call:
    - other jobs
    - operations
    - features
    - services within the same module
- May use:
    - drivers
    - services from other modules (in a modular monolith)

Jobs are the smallest unit. Complex behavior emerges from composing simple jobs.
Small units, but not split up artificially. The criterion is not length, but cohesion. If they are part of the same logic step, do not separate them.

```js
// /src/jobs/createParty.js
"use strict";

const process = require("node:process");
const path = require("node:path");

const http = require(path.resolve(process.cwd(), "drivers", "http"));

/**
 * @param {Object} payload
 *
 * @return {Promise<*>}
 */
module.exports = async function (payload) {

    // allocate a new party via the external party service
    const response = await http({
        method: 'post',
        url: "/parties/allocate",
        data: {
            "displayName": payload.email
        }
    });

    console.log(`-> ${payload.email} party created, identifier: ${response.data.result.identifier}`);

    return response.data.result;

};
```

---

### Operations

- Are reusable compositions of jobs — increase code reusability by piecing jobs together to provide composite functionalities
- An operation can call as many jobs as needed
- Used when a sequence of jobs is reused across multiple features
- Must not call:
    - other operations
    - features
    - services within the same module
- May use jobs only

```js
// /src/operations/setUpParty.js
"use strict";

const process = require("node:process");
const path = require("node:path");

const constants = require(path.resolve(process.cwd(), "config", "constants"));

const getPartyJob = require(path.resolve(process.cwd(), "src", "jobs", "getParty"));
const createPartyJob = require(path.resolve(process.cwd(), "src", "jobs", "createParty"));

/**
 * @param {string} user e.g. "user@example.com"
 *
 * @return {Promise<*>}
 */
module.exports = async function (user) {

    // try to retrieve an existing party
    let party = await getPartyJob(constants.MEDIATOR);

    // if not found, create a new one
    if (!party) {
        party = await createPartyJob({email: user})
    }

    return party;
};
```

---

### Features

- Represent a single application capability (business functionality)
- Are composed of jobs and/or operations
- Must not call other features
- May use:
    - jobs
    - operations
    - drivers
    - services from other modules (in a modular monolith)

A feature must have a clear and single purpose.

```js
// /src/features/requestSubscription.js
"use strict";

const process = require("node:process");
const path = require("node:path");

const constants = require(path.resolve(process.cwd(),  "config", "constants"));

const setUpInstitutionOperatorsOperation = require(path.resolve(process.cwd(), "src", "operations", "setUpInstitutionOperators"));
const setUpOperatorOperation = require(path.resolve(process.cwd(), "src", "operations", "setUpOperator"));
const createContractJob = require(path.resolve(process.cwd(), "src", "jobs", "createContract"));
const exerciseChoiceJob = require(path.resolve(process.cwd(), "src", "jobs", "exerciseChoice"));

/**
 * @param {Object} payload
 *
 * @return {Promise<void>}
 */
module.exports = async function (payload) {

    const mediator = payload.mediator
    const operator = payload.operator;
    const bic11 = payload.bic11;
    const type = payload.type;
    const templateId = constants.template_ids[`${type}_SIGNATURE_COLLECTOR`];

    // create and add operator
    await setUpOperatorOperation({
        email: operator.displayName,
        partyId: operator.identifier,
        mediator: mediator.identifier,
        status: constants.operator_statuses.ACTIVE
    });

    // create institutionOperators adding the current operator
    const institutionOperatorsResult = await setUpInstitutionOperatorsOperation({
        mediator: mediator.identifier,
        bic11: bic11,
        operatorToAdd: operator.identifier
    });

    // create a pending subscription request (as a proxy contract)
    const pendingSubscriptionResult = await createContractJob({
        controller: mediator.identifier,
        data: {
            templateId: templateId,
            payload: {
                mediator: mediator.identifier,
                alreadySigned: [mediator.identifier],
                operators: institutionOperatorsResult.payload.operators,
                institutionBic11: bic11,
                status: constants.request_statuses.REQUESTER_PENDING_SIGNATURE
            }
        }
    });

    // sign the subscription as the requesting operator
    const requesterSignature = await exerciseChoiceJob({
        controller: operator.identifier,
        data: {
            templateId: templateId,
            contractId: pendingSubscriptionResult.contractId,
            choice: "SignAsRequester",
            argument: {
                signer: operator.identifier
            }
        }
    });

    console.log(requesterSignature);
    console.log("-> done")

};
```

---

### Services

- Are the entry point to the application core
- Represent a complete business request
- Are called by:
    - HTTP frameworks
    - CLI programs
    - other modules (in a modular monolith)
- Must not call other services within the same module
- May orchestrate:
    - features
    - operations
    - jobs
    - drivers

A service is what you expose to the outside world.
Services are the only functions (FaaS) exposed by our projects.
Every other function (features, operations, jobs) is not directly available from outside; instead, they are used by the services.
This rule allows to have a clear and unequivocal knowledge of the functionality exposed by our projects, regardless of how they will be used and regardless of the internal implementation.

**ATTENTION**: the service concept of the Luminous architecture is different from the service concept of the Lucid Architecture.

```js
// /src/services/subscription.js
"use strict";

const process = require("node:process");
const path = require("node:path");

const constants = require(path.resolve(process.cwd(), "config", "constants"));

const requestSubscriptionFeature = require(path.resolve(process.cwd(), "src", "features", "requestSubscription"));
const setUpPartyOperation = require(path.resolve(process.cwd(), "src", "operations", "setUpParty"));

/**
 * @param {string} bic e.g. "DEUTDEFFXXX"
 * @param {string} email e.g. "user@example.com"
 *
 * @return {Promise<*>}
 */
module.exports = async function (bic, email) {

    // 1. first of all allocate party and store them
    const mediator = await setUpPartyOperation(constants.MEDIATOR);
    // allocate also the mediator for dev environment
    const party = await setUpPartyOperation(email);

    // 2. make subscription
    const payload = {
        type: constants.SUBSCRIPTION,
        bic11: bic,
        mediator: mediator,
        operator: party
    };

    return await requestSubscriptionFeature(payload);

};
```

#### Service vs Feature

- **Feature**: Represents a single capability
- **Service**: Exposes capabilities to the outside world, can orchestrate multiple features, and represents a full business request

In some cases, a service and a feature may coincide.

---

### Drivers

- Are the interface to the external world:
    - databases
    - external APIs
    - Redis
    - LLMs
    - file system
- Must not use other drivers
- Live outside the domain logic

Drivers are equivalent to "ports/adapters" in hexagonal architecture.

---


## Folder Structure

`/src` must contain domain logic only.

No framework-related code inside `/src`.

The application entrypoint must live outside `/src`.

```text
/my-app
  /framework-related    (e.g. /server for HTTP routes, /config for constants)
  /src
    /drivers
    /services
    /features
    /operations
    /jobs
  /tests
    /features            (Gherkin .feature files)
      /step_definitions  (Cucumber step definitions)
    /fixtures            (test data, sample files)
```

### Modular Monolith Variant

```text
/src
  /drivers
  /shared
    /jobs
    /operations
  /moduleA
    /services
    /features
    /operations
    /jobs
  /moduleB
    /services
    /features
    /operations
    /jobs
    ...
```

`/shared` contains only non-business code — generic utilities. Similar to an external library.

Tradeoff: centralized bug risk vs duplication across modules.

---

## File Naming Conventions

- All file names use **camelCase**
- Jobs: verb-first describing the single action — e.g. `createParty.js`, `getParty.js`, `parseArgv.js`, `generateToken.js`
- Operations: verb-first describing the composite outcome — e.g. `setUpParty.js`, `setUpInstitutionOperators.js`
- Features: verb-first describing the business capability — e.g. `requestSubscription.js`
- Services: noun or verb describing the exposed business request — e.g. `subscription.js`, `getUserByID.js`
- Drivers: noun describing the external resource — e.g. `http.js`, `mariadb.js`, `redis.js`
- One exported function per file
- All files must use `LF` (unix) line separator

---

## How to Bind the HTTP Server with Business Logic

Use a single service function call inside a single server route definition:

```js
// call a single service inside a http route callback
"use strict";

const process = require("node:process");
const path = require("node:path");
const exampleService = require(path.resolve(process.cwd(), "src", "services", "exampleService.js"));

fastify.get("/example", async function(req, resp) {
    const payload = req.body;
    const data = await exampleService(payload);
    return resp.send(data);
});
```

---

## How to Start Writing Business Logic

Start from the simplest task (a single `job`) and compose jobs together in an `operation`, and operations in a `feature`, and features in a `service` as the complexity of the task increases.

The simplest service can be just a pointer to a job:

```js
// /src/services/exampleService.js
"use strict";

const process = require("node:process");
const path = require("node:path");
const exampleJob = require(path.resolve(process.cwd(), "src", "jobs", "exampleJob"));
module.exports = exampleJob;
```

---

## How to Verify Service Isolation

Services must expose well-defined contracts, completely isolated from the HTTP server implementation.

Verify by using services both inside a route:

```js
"use strict";

const path = require("node:path");
const process = require("node:process");
const getUserByIDService = require(path.resolve(process.cwd(), "src", "services", "getUserByID.js"));

fastify.get("/user/:id", async function(req, resp) {
    const id = req.query.id;
    const data = await getUserByIDService(id);
    return resp.send(data);
});
```

...and also via CLI, outside the HTTP server entirely:

```sh
# call the service via CLI
node run getUserByID --id=23
```

```js
// run a service via CLI
// run.js file
"use strict";

const path = require("node:path");
const process = require("node:process");
const { readdir } = require("node:fs/promises");
const servicesDirectory = path.resolve(process.cwd(), "src", "services");
const parseArgvJob = require(path.resolve(process.cwd(), "src", "jobs", "parseArgv.js"));

async function main () {

    try {

        // discover all available services by listing the services directory
        const availableServices = (await readdir(servicesDirectory)).map(function (service) {
            return path.parse(service).name;
        });

        // parse command line arguments and match to a known service
        const payload = await parseArgvJob(availableServices);

        // load and execute the requested service
        const service = require(path.resolve(servicesDirectory, payload.service_name));
        const data = await service(payload);

        if (data) {
            console.log(JSON.stringify(data, null, 2));
        }

        process.exit(0);
    } catch (e) {
        console.log(JSON.stringify({
            status: "ERROR",
            message: e.message
        }, null, 2));
        process.exit(1);
    }

}

main();
```

If a service works both in a route callback and via CLI without any change, its contract is clean.

---

## Testing

### Testing strategy per layer

- **Jobs**: test with unit tests
- **Operations**: test with unit tests
- **Features**: test with Cucumber / Gherkin
- **Services**: test with Cucumber / Gherkin

### Gherkin specifications

Write executable specifications in plain text via the Gherkin grammar:

```gherkin
# /tests/features/index.feature
  Scenario: html-to-pdf
    Given the html file "/tests/fixtures/actide_test.html"
    When performing 1 POST "/createpdf" request
    Then a pdf file should be downloaded
    Then http response status code should be 200
```

### Step definitions

Implement those specifications by writing all the required step definitions:

```js
// /tests/features/step_definitions/index.js
"use strict";

const process = require("node:process");
const path = require("node:path");
const { Given, When, Then, Before } = require('@cucumber/cucumber');
const config = require(path.resolve(process.cwd(), "config"));
const axios = require("axios");
const fsPromises = require('node:fs').promises;
axios.defaults.baseURL = `http://127.0.0.1:${config.HTTP_PORT}`;
const generateTokenJob = require(path.resolve(process.cwd(), "src", "jobs", "generateToken.js"));

const FormData = require("form-data");
const fs = require("node:fs");

const tokenGenerationPayload = {
    "scope":["/signature", "/createpdf", "/anonymize", "/upload"]
};

Before(function () {
    this.response = [];
});

// =============================================================================
// Scenario: html-to-pdf
// =============================================================================
Given("the html file {string}", async function (file) {
    this.absoluteHtmlFilePath = path.resolve(process.cwd(), ...file.split(path.sep));
});

When("performing {int} POST {string} request", {timeout: 60 * 1000}, async function (numberOfHttpRequests, httpPath) {

    // generate an auth token with the required scopes
    const token = await generateTokenJob(tokenGenerationPayload);

    for (let i = 0; i < numberOfHttpRequests; i += 1) {
        const data = new FormData();
        if (this.absoluteHtmlFilePath) {
            data.append('data', fs.createReadStream(this.absoluteHtmlFilePath));
        } else {
            data.append('data', "");
        }

        const axiosConfig = {
            method: 'post',
            maxBodyLength: Infinity,
            url: httpPath,
            headers: {
                "authorization": "Bearer " + token,
                'x-patient-code': 'abc',
                ...data.getHeaders()
            },
            data : data
        };

        let response;
        try {
            response = await axios(axiosConfig);
        } catch (e) {
            response = e.response;
        }

        this.response.push(response);
    }

});

Then("a pdf file should be downloaded", async function () {
    const response = this.response[0];
    if (this.response.length !== 1) {
        throw new Error(`too many responses`);
    }
    if (response.status !== 200) {
        throw new Error(`Invalid response code: ${response.status}`);
    }
    if (response.headers["content-type"] !== "application/pdf") {
        throw new Error(`invalid content type: ${response.headers["content-type"]}`);
    }
});

Then("http response status code should be {int}", async function (statusCode) {
    const response = Array.isArray(this.response) ? this.response[0] : this.response;
    if (response.status !== statusCode) {
        throw new Error(`Invalid response code: ${response.status}`);
    }
});
```

---

## Common Mistakes — What NOT to Do

These examples show violations of Luminous rules. Never produce code like this.

### WRONG: A job calling another job

```js
// ❌ VIOLATION: jobs must not call other jobs
// /src/jobs/createAndNotifyParty.js
const createPartyJob = require(path.resolve(process.cwd(), "src", "jobs", "createParty"));
const sendEmailJob = require(path.resolve(process.cwd(), "src", "jobs", "sendEmail"));

module.exports = async function (payload) {
    const party = await createPartyJob(payload);
    await sendEmailJob({ to: payload.email, subject: "Party created" });
    return party;
};
```

**Why it is wrong:** A job must do one thing only and must not call other jobs. This should be an operation.

### WRONG: An operation calling another operation

```js
// ❌ VIOLATION: operations must not call other operations
// /src/operations/fullSetup.js
const setUpPartyOperation = require(path.resolve(process.cwd(), "src", "operations", "setUpParty"));
const setUpOperatorOperation = require(path.resolve(process.cwd(), "src", "operations", "setUpOperator"));

module.exports = async function (payload) {
    const party = await setUpPartyOperation(payload.email);
    await setUpOperatorOperation({ partyId: party.identifier });
    return party;
};
```

**Why it is wrong:** An operation may only compose jobs. If you need to combine operations, that is a feature.

### WRONG: A feature calling another feature

```js
// ❌ VIOLATION: features must not call other features
// /src/features/onboardAndSubscribe.js
const onboardFeature = require(path.resolve(process.cwd(), "src", "features", "onboard"));
const requestSubscriptionFeature = require(path.resolve(process.cwd(), "src", "features", "requestSubscription"));

module.exports = async function (payload) {
    await onboardFeature(payload);
    await requestSubscriptionFeature(payload);
};
```

**Why it is wrong:** Features must not call other features. If you need to orchestrate multiple features, that is a service.

### WRONG: Framework code inside /src

```js
// ❌ VIOLATION: /src must contain domain logic only, no framework code
// /src/services/subscription.js
const fastify = require("fastify");

module.exports = async function (req, resp) {
    // accessing req and resp inside a service breaks isolation
    const bic = req.body.bic;
    // ...
};
```

**Why it is wrong:** Services must not know about HTTP, request/response objects, or any framework. The service receives plain data and returns plain data.

### WRONG: Over-engineering with unnecessary layers

```js
// ❌ UNNECESSARY COMPLEXITY: creating an operation that wraps a single job
// /src/operations/getPartyOperation.js
const getPartyJob = require(path.resolve(process.cwd(), "src", "jobs", "getParty"));

module.exports = async function (user) {
    return await getPartyJob(user);
};
```

**Why it is wrong:** This operation adds no boundary, no reuse, and no meaningful name. The feature or service should call the job directly. Do not introduce a layer unless it adds real value.

### WRONG: Passing entire objects when only one field is needed

```js
// ❌ VIOLATION: passing the whole user object when only the email is needed
const createPartyJob = require(path.resolve(process.cwd(), "src", "jobs", "createParty"));

await createPartyJob(user); // user has 20 fields, only email is used inside

// ✅ CORRECT:
await createPartyJob({ email: user.email });
```

---

## Clean Code Guidelines

These principles MUST be followed when generating code:

- Reduce cognitive load by using semantic variable names, adding semantic comments, separating visually the parts of the code
- Every instruction or block of related instructions MUST be commented with a clear, meaningful English explanation of what it does and why. Only exception: self-evident instructions
- Use self-explanatory names
- Avoid ambiguous abbreviations
- Separate cohesive code sections visually
- **KISS** — Keep it simple stupid
- **YAGNI** — You ain't gonna need it. Keep things simple
- **DRY** — Don't repeat yourself
- Pass only the necessary inputs (avoid passing whole objects when not needed)
- Write comments to explain *why* the code is doing a certain action
- Make small commits, group changes per subtask. Do not make one commit with many files related to many different tasks

---

## External Libraries

External libraries can be used inside any layer (most commonly inside jobs — e.g. libraries for PDF generation, email sending, etc.).

---

## Documentation

Use ADRs (Architecture Decision Records) to document architectural decisions.

Also document:

- Key business concepts
- Important workflows
- Module boundaries
- Integration contracts
- Exceptional tradeoffs or rule deviations

If a team (or an AI agent) breaks a default architectural rule intentionally, that decision must be documented and easy to find.

---

## FAQ

### When to create an Operation?

Create an operation when:

- The same sequence of jobs is reused in multiple places, or
- That sequence deserves a meaningful name

Do not create an operation for one-time glue code.

### When to create a Feature?

Create a feature when:

- The behavior represents a business capability
- The use case is more than simple low-level composition

### When to create a Service?

Create a service when:

- The behavior must be exposed to an external caller
- It represents a complete business request
- It defines an application boundary

### How to check service isolation?

Try to call the service both from a HTTP route and from a CLI script. If both work without any change to the service code, the contract is clean.


## AI Agent Pre-Flight Checklist

Before writing any code, verify:

1. **Which layer is this?** Identify whether the code belongs to a job, operation, feature, service, or driver.
2. **Does it call only allowed layers?** Check the dependency direction rules below. Violations are never acceptable.
3. **Is there an existing job/operation that already does this?** Do not duplicate. Reuse existing units.
5. **Am I passing only necessary inputs?** Do not pass whole objects when only one field is needed.
6. **Does every file follow the naming convention?** See the naming rules below.
7. **Is every code block commented with a meaningful explanation?** Comments explain *why*, not just *what*.