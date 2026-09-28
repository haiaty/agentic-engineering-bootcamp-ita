//=====================
// rank file volatility job
// Single action: order files by volatility. Primary key: number of
// modifications, descending. Secondary key: file path in plain
// code-unit alphabetical order, which is stable and locale-independent
// (unlike localeCompare), guaranteeing a deterministic output for ties.
//======================
"use strict";

/**
 * @param {Array<{path: string, changes: number}>} fileChanges per-file modification counts
 *
 * @return {Promise<Array<{path: string, changes: number}>>} the same entries, ordered
 */
module.exports = async function (fileChanges) {

    // Work on a copy: the input array must never be mutated in place
    const orderedFiles = fileChanges.slice();

    orderedFiles.sort(function (left, right) {
        if (left.changes !== right.changes) {
            return right.changes - left.changes;
        }
        if (left.path < right.path) {
            return -1;
        }
        if (left.path > right.path) {
            return 1;
        }
        return 0;
    });

    return orderedFiles;
};
