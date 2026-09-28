//=====================
// cucumber-js configuration
// Our BDD specs live outside the framework defaults:
// features in tests/features, step definitions in tests/steps_definitions,
// both organized by business domain (see the bdd-gherkin-feature-writer skill).
// Telemetry/publish is disabled for reproducible, offline-friendly runs.
//======================
"use strict";

module.exports = {
    "default": {
        "paths": ["tests/features/**/*.feature"],
        "import": ["tests/steps_definitions/**/*.js"],
        "publish": false
    }
};
