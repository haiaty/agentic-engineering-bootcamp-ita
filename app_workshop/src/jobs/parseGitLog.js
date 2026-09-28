//=====================
// parse git log job
// Single action: translate the raw `git log --name-only` output (see the
// git driver) into a list of revisions, each with its hash and the unique
// file paths changed in that revision.
//======================
"use strict";

// Must match the marker defined in src/drivers/git.js
const REVISION_MARKER = "\u0001";

//=====================
// git path unquoting
// git wraps paths containing special characters in double quotes
// (core.quotePath). We strip the surrounding quotes; full C-style
// unescaping of non-ASCII paths is out of scope for this story.
//======================
function unquoteGitPath(rawPath) {
    if (rawPath.length >= 2 && rawPath.startsWith("\"") && rawPath.endsWith("\"")) {
        return rawPath.slice(1, -1);
    }
    return rawPath;
}

/**
 * @param {string} rawLog raw `git log --name-only` output from the git driver
 *
 * @return {Promise<Array<{revision: string, files: string[]}>>} revisions in git order (newest first)
 */
module.exports = async function (rawLog) {

    const revisions = [];
    let currentRevision = null;

    for (const line of rawLog.split("\n")) {

        //=====================
        // revision header
        // A marker line closes the previous revision (if any) and opens
        // the next one; the hash is everything after the marker.
        //======================
        if (line.startsWith(REVISION_MARKER)) {
            if (currentRevision) {
                revisions.push(currentRevision);
            }
            currentRevision = {
                "revision": line.slice(REVISION_MARKER.length),
                "files": []
            };
            continue;
        }

        // Blank lines only separate commit blocks in the raw output
        if (line === "") {
            continue;
        }

        //=====================
        // changed file path
        // A file listed more than once in the same revision must count
        // as a single modification, hence the dedup check before push.
        //======================
        const filePath = unquoteGitPath(line);
        if (!currentRevision.files.includes(filePath)) {
            currentRevision.files.push(filePath);
        }
    }

    // The raw output does not end with a marker line, so flush the last revision
    if (currentRevision) {
        revisions.push(currentRevision);
    }

    return revisions;
};
