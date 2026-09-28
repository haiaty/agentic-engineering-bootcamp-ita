//=====================
// git driver
// The only code allowed to talk to the git CLI (outside world).
// It returns the RAW `git log` output; translating it into domain
// data is the responsibility of the parseGitLog job, keeping this
// driver free of any business logic.
//======================
"use strict";

const { execFile } = require("node:child_process");

//=====================
// revision marker
// Control character 0x01, emitted by git right before each commit hash
// thanks to the %x01 pretty-format escape. It cannot appear in commit
// hashes nor in file paths, so it is a safe delimiter between revisions.
//======================
const REVISION_MARKER = "\u0001";

//=====================
// git command runner
// Thin promise wrapper around execFile. On failure it rejects with the
// git stderr text, because that text carries the explanation we need
// to distinguish "empty repository" from a real error.
//======================
function runGit(repositoryPath, gitArguments) {
    return new Promise(function (resolve, reject) {
        execFile("git", gitArguments, {
            "cwd": repositoryPath,
            // a long history with many changed files can exceed the 1MB default buffer
            "maxBuffer": 32 * 1024 * 1024
        }, function (error, stdout, stderr) {
            if (error) {
                reject(new Error(stderr.trim()));
            } else {
                resolve(stdout);
            }
        });
    });
}

/**
 * @param {Object} payload
 * @param {string} payload.repoPath absolute path of the git repository to read
 * @param {string} [payload.range] git revision range limiting the analyzed history, e.g. "HEAD~2..HEAD"; absent means full history
 *
 * @return {Promise<string>} raw stdout of `git log --name-only`
 */
module.exports = async function (payload) {

    //=====================
    // log command
    // One "\x01<hash>" line per revision, followed by the relative file
    // paths changed in that revision. Note: merge commits list no files
    // with the default diff mode (no -m/--first-parent), which is fine
    // because merges rarely change files directly.
    //======================
    const gitArguments = [
        "log",
        "--name-only",
        "--pretty=format:" + REVISION_MARKER + "%H"
    ];

    //=====================
    // optional history range
    // The range is appended only when present: `git log` without a range
    // already means "full history", so no default value is invented here.
    //======================
    if (payload.range) {
        gitArguments.push(payload.range);
    }

    try {
        return await runGit(payload.repoPath, gitArguments);
    } catch (gitError) {

        //=====================
        // empty repository
        // `git log` fails on a repository without commits; that is a valid
        // "no changes" condition for the callers, not an error to surface.
        //======================
        if (gitError.message.includes("does not have any commits yet")) {
            return "";
        }

        // Any other failure (not a repo, bad range, git missing, ...) is a real error and must not be swallowed
        throw gitError;
    }
};
