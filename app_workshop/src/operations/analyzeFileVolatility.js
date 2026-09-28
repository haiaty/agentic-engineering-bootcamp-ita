//=====================
// analyze file volatility operation
// Composite functionality: run the whole volatility pipeline
// raw git log -> revisions -> per-file counts -> volatility ranking.
// Only composes jobs, as required by the Luminous architecture.
//======================
"use strict";

const process = require("node:process");
const path = require("node:path");

const loadGitLogJob = require(path.resolve(process.cwd(), "src", "jobs", "loadGitLog"));
const parseGitLogJob = require(path.resolve(process.cwd(), "src", "jobs", "parseGitLog"));
const countFileModificationsJob = require(path.resolve(process.cwd(), "src", "jobs", "countFileModifications"));
const rankFileVolatilityJob = require(path.resolve(process.cwd(), "src", "jobs", "rankFileVolatility"));

/**
 * @param {Object} payload
 * @param {string} payload.repoPath absolute path of the git repository to analyze
 * @param {string} [payload.range] git revision range limiting the analyzed history, e.g. "HEAD~2..HEAD"
 *
 * @return {Promise<{analyzedRevisions: number, files: Array<{path: string, changes: number}>, message: string|null}>}
 */
module.exports = async function (payload) {

    //=====================
    // volatility pipeline
    // Each step is a single-responsibility job; the composition here is
    // the only place where the whole flow is visible at a glance.
    //======================
    const rawLog = await loadGitLogJob({
        "repoPath": payload.repoPath,
        "range": payload.range
    });
    const revisions = await parseGitLogJob(rawLog);
    const fileChanges = await countFileModificationsJob(revisions);
    const rankedFiles = await rankFileVolatilityJob(fileChanges);

    //=====================
    // explicit empty-state message
    // An empty list must never be silent: when no file was modified in
    // the analyzed range, message is set so the caller can display it.
    //======================
    const message = rankedFiles.length === 0
        ? "No file modifications found in the analyzed history range"
        : null;

    return {
        "analyzedRevisions": revisions.length,
        "files": rankedFiles,
        "message": message
    };
};
