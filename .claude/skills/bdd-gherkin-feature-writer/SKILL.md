---

name: bdd-gherkin-feature-writer
description: Use when writing/creating or modifying BDD Gherkin `.feature` files and JavaScript Cucumber step definitions for this project.
-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

# BDD Gherkin Feature Writer

## Purpose

Write and modify BDD Gherkin `.feature` test files and their JavaScript Cucumber step definitions for this project.

Tests must be organized by business domain, not by UI surface. Use shared domain language across CLI, web page, API, and other surfaces when they test the same business capability.

## When to Use This Skill

Use this skill when the user asks to:

* Create a new `.feature` file.
* Modify an existing `.feature` file.
* Add Cucumber scenarios.
* Add or update JavaScript step definitions.
* Organize tests under `tests/features/` or `tests/steps_definitions/`.
* Write API, database, audit trail, or response-payload assertions in BDD tests.

## When NOT to Use This Skill

Do not use this skill for:

* Unit tests.
* Non-Cucumber test frameworks.
* UI-only test organization by page/component.
* Generic test strategy documents.
* Step definitions that are already implemented in common shared steps.

## Required Folder Structure

Always organize test files by domain:

```text
tests/
  features/
    <domain>/
      <capability>.feature
  steps_definitions/
    <domain>/
      <capability>Steps.js
```

The first folder level must be the business domain.

Do not organize by UI surface such as:

```text
tests/features/pages/
tests/features/api/
tests/features/cli/
```

## Domain Selection Rules

Use a domain folder when:

* The capability has a distinct business vocabulary.
* The capability maps to a Luminous module or service boundary.
* The steps do not naturally belong to an existing domain folder.

Example:

```text
tests/
  features/
    enrollment/
      edc_initiated.feature
  steps_definitions/
    enrollment/
      enrollmentSteps.js
```

If a feature spans multiple UI surfaces, such as CLI, page, and API, keep it in the same domain folder.

## Naming Rules

Feature files:

```text
<capability>.feature
```

Step definition files:

```text
<capability>Steps.js
```

Keep each step definition file focused on a single capability or `.feature` file.

Do not mix step definitions from unrelated features in the same file.

## Scenario Tag Rules

Only add the tag:

```gherkin
@USXXX-feature-y-scenario-z
```

where XXX is the user story number and y is the feature number and z the scenario number

Do not add any other scenario tags.

The user will add additional tags manually later.

Add tag only on scenarios, not on Feature or other places.

## Feature File Writing Rules

Write scenarios using clear business language.

Prefer domain vocabulary over implementation vocabulary unless the step specifically interacts with HTTP, database, audit trail, or response payloads.

Use `Background` only when several scenarios share the exact same preconditions.

Avoid overly technical scenario names unless the behavior is technical by nature.

## HTTP Request Step with JSON Payload

For HTTP calls with JSON payloads, always use a Doc String.

Do not use Data Tables for JSON payloads.

Use this format:

```gherkin
When I make a "POST" request to "/v1/enrollment" with payload:
      """
      {
        "investigator_id": 1,
        "external_edc_patient_id": 1001,
        "date_of_birth": "1988/02/02",
        "place_of_birth": "novara",
        "patient_first_name": "John",
        "patient_last_name": "Doe",
        "delivery_channel": "EMAIL",
        "contact_email": "haiaty.varotto@nubilaria.com"
      }
      """
```

Replace the HTTP method, endpoint, and payload as needed.

Keep JSON valid.

## Audit Trail Assertion Step

- When verifying data in the `audit_trail` table, use this step format:

```gherkin
And a record on audit trail must exist with:
      | field                   | value       |
      | event_type              | ENROLLMENT  |
      | external_edc_patient_id | 1001        |
      | investigator_id         | 1           |
      | actor_type              | EDC_SYSTEM  |
      | payload.status          | PENDING     |
```

Use this for audit trail assertions instead of creating custom one-off audit trail steps.


- to assert a non empty value in audit trails payload

```
And the payload column in the record on audit trail should have a non-empty "reference_number"
```

## HTTP Response Data Assertion Step

- When verifying fields in the `data` part of the HTTP response payload, use this step format:

```gherkin
And the data part in response should contain:
      | field                   | value |
      | valid                   | true  |
      | external_edc_patient_id | 1001  |
```

- When  `data` contains a nested object you can use the `.` to verify nested objects, like this:
```gherkin
And the data part in response should contain:
      | field                   | value |
      | pagination.total                    | 2  |
```

- When  `data` contains a nested object with a nested array, you can use the `.` to verify nested properties, like this example where I verify the first element of the array to have id equals to 2
```gherkin
And the data part in response should contain:
      | field                   | value |
      | items.0.id                     | 2  |
```

- When verifying fields in the `errors` part, which is an array, use this step format:

```gherkin
And the errors part should contain an item having:
| row_number        | 2 |
| column        | kit_type |
| value        | InvalidType |
| reason        | KIT_TYPE_NOT_FOUND |
```
the data table is an table in which the first column is the name of the property of the array element, and the second is the value

- to assert a non empty value in the data part of the http response:

```gherkin
And the response data part should contain a non-empty "reference_number"
```

## Database Table Column Assertion Step

- To verify values in a database table row, use this step format:
  to do database checks, use this step format

```gherkin
And the "<table_name>" where "<where_condition>" should have these values:
| field       | value                  |
| id          | 1                      |
| name        | PharmaCorp Manufacturer|
| entity_type | manufacturer           |
| is_active   | 1                      |
```

Example:

```gherkin
And the "patients" where "external_id=3 AND investigator_id=2" should have these values:
| field       | value                  |
| id          | 1                      |
| name        | PharmaCorp Manufacturer|
| entity_type | manufacturer           |
| is_active   | 1                      |
```

- use this to check no records are present in a table:

```gherkin
And no record should be created in 'audit_trails'
```

## Audit table steps

- to assert a non empty value in audit trails payload

```gherkin
And the payload column in the record on audit trail should have a non-empty "reference_number"
```


## Common Steps Reuse Rule

Before writing any new step definition, check whether the step already exists in:

```text
tests/steps_definitions/commonSteps.js
```

If the step exists, reuse it.

Do not duplicate shared common steps in domain-specific step files.

This is especially important for:

* HTTP request steps.
* HTTP response assertion steps.
* Audit trail assertion steps.
* Database table value assertion steps.

## Step Definition Implementation Rules

Step definitions must perform real work and real assertions.

Do not implement placeholder steps that only set flags, comments, or mock intent without actual behavior.

Avoid this pattern:

```javascript
Given(
  "the OTP service is experiencing internal errors",
  function () {
    this.otpServiceError = true;
    // In a real test environment, this could mock the database driver.
  }
);
```

This is not acceptable because it does not create a real test condition or assertion.

Instead, implement the actual behavior needed by the test environment, such as:

* seeding database state,
* calling a helper that sets up the condition,
* asserting actual database or response state,
* using an existing common step.

## Step Definition Scope Rules

Domain-specific step definition files should only contain steps for their matching capability.

Do not place generic reusable steps in domain-specific files.

Generic steps belong in:

```text
tests/steps_definitions/commonSteps.js
```

Capability-specific steps belong in:

```text
tests/steps_definitions/<domain>/<capability>Steps.js
```

## Preferred Scenario Shape

Use this general structure:

```gherkin
@featurex
Feature: <Business capability>

  Scenario: <business behavior>
    Given <business precondition>
    When <action happens>
    Then <business outcome should happen>
    And <technical assertion if needed>
```

Keep scenario steps readable by domain experts.

Use technical assertions only where they verify important system behavior.

## Good Example

```gherkin
@featurex
Feature: EDC initiated enrollment

  Scenario: Create a pending enrollment from an EDC request
    When I make a "POST" request to "/v1/enrollment" with payload:
      """
      {
        "investigator_id": 1,
        "external_edc_patient_id": 1001,
        "date_of_birth": "1988/02/02",
        "place_of_birth": "novara",
        "patient_first_name": "John",
        "patient_last_name": "Doe",
        "delivery_channel": "EMAIL",
        "contact_email": "haiaty.varotto@nubilaria.com"
      }
      """
    Then the response status should be 201
    And the data part in response should contain:
      | field                   | value |
      | valid                   | true  |
      | external_edc_patient_id | 1001  |
    And a record on audit trail must exist with:
      | field                   | value      |
      | event_type              | ENROLLMENT |
      | external_edc_patient_id | 1001       |
      | investigator_id         | 1          |
      | actor_type              | EDC_SYSTEM |
      | payload.status          | PENDING    |
```

## Things to Avoid

Do not organize tests by UI surface.

Do not create:

```text
tests/features/api/
tests/features/pages/
tests/features/cli/
```

Do not use Data Tables for JSON HTTP payloads.

Do not duplicate steps that already exist in `commonSteps.js`.

Do not create placeholder step definitions.

Do not mix step definitions from multiple features into one capability step file.

Do not create overly broad domains when a more precise business domain exists.

Do not invent custom audit trail or response assertion steps when the shared formats already cover the case.

## Checklist Before Finishing

Before returning generated files, verify:

* Feature file is under `tests/features/<domain>/<capability>.feature`.
* Step definition file is under `tests/steps_definitions/<domain>/<capability>Steps.js`.
* JSON payloads use Doc Strings, not Data Tables.
* Audit trail checks use `a record on audit trail must exist with:`.
* Response data checks use `the data part in response should contain:`.
* Database value checks use the shared table/where-condition Doc String step.
* No shared common step has been reimplemented.
* No placeholder step definitions were added.
* Step definitions contain real implementation logic.