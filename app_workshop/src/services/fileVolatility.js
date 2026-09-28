//=====================
// file volatility service
// The exposed business request of user story 1: given a project
// (git repository), return the files ordered by modification frequency.
// Services are the only functions available to the outside world; this
// one is a thin, contract-validating pointer to the volatility operation.
// It receives and returns plain data, so it works unchanged from the CLI
// or from any future HTTP route (Luminous service isolation).
//======================
"use strict";

const process = require("node:process");
const path = require("node:path");

const analyzeFileVolatilityOperation = require(path.resolve(process.cwd(), "src", "operations", "analyzeFileVolatility"));

/**
 * @param {Object} payload
 * @param {string} payload.repoPath absolute path of the git repository to analyze
 * @param {string} [payload.range] git revision range limiting the analyzed history, e.g. "HEAD~2..HEAD"
 *
 * @return {Promise<{analyzedRevisions: number, files: Array<{path: string, changes: number}>, message: string|null}>}
 */
module.exports = async function (payload) {

    //=====================
    // contract validation
    // Fail fast with an explicit error instead of guessing a repository:
    // no default value is invented when a required key is not present.
    //======================
    if (!payload || !payload.repoPath) {
        throw new Error("repoPath is required to analyze file volatility");
    }

    return await analyzeFileVolatilityOperation(payload);
};
