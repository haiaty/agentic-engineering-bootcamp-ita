//=====================
// load git log job
// Single action: fetch the raw git log of a repository, delegating the
// outside-world access to the git driver. It exists as a job because
// operations may only compose jobs (never drivers), and because it gives
// the operation a domain-meaningful step name.
//======================
"use strict";

const process = require("node:process");
const path = require("node:path");

const gitDriver = require(path.resolve(process.cwd(), "src", "drivers", "git"));

/**
 * @param {Object} payload
 * @param {string} payload.repoPath absolute path of the git repository to read
 * @param {string} [payload.range] git revision range limiting the analyzed history
 *
 * @return {Promise<string>} raw git log output
 */
module.exports = async function (payload) {
    return await gitDriver({
        "repoPath": payload.repoPath,
        "range": payload.range
    });
};
