//=====================
// count file modifications job
// Single action: count, for every distinct file path, how many revisions
// modified it. Volatility is frequency of modifications: each (file,
// revision) pair contributes exactly one change, never the number of
// lines touched. Files are already unique per revision thanks to the
// parseGitLog job, so a plain increment is correct.
//======================
"use strict";

/**
 * @param {Array<{revision: string, files: string[]}>} revisions parsed git log revisions
 *
 * @return {Promise<Array<{path: string, changes: number}>>} one entry per distinct file path
 */
module.exports = async function (revisions) {

    const changesByPath = new Map();

    for (const revision of revisions) {
        for (const filePath of revision.files) {
            // start from 0 only the first time a path is seen; never invent a value for unseen paths
            const previousCount = changesByPath.has(filePath) ? changesByPath.get(filePath) : 0;
            changesByPath.set(filePath, previousCount + 1);
        }
    }

    return Array.from(changesByPath.entries()).map(function (entry) {
        return {
            "path": entry[0],
            "changes": entry[1]
        };
    });
};
