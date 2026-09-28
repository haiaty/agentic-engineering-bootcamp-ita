//=====================
// file volatility step definitions
// Capability: file volatility (user story 1).
// The steps build a real temporary git repository for every scenario
// and call the real fileVolatility service, so the whole pipeline
// (driver -> jobs -> operation -> service) is exercised end to end.
//======================
"use strict";

const process = require("node:process");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");
const assert = require("node:assert");
const { execFile } = require("node:child_process");
const { Given, When, Then, After } = require("@cucumber/cucumber");

const fileVolatilityService = require(path.resolve(process.cwd(), "src", "services", "fileVolatility"));

//=====================
// helpers
//======================

// Run a git command inside the temporary repository; reject with git stderr on failure
function git(repositoryPath, gitArguments) {
    return new Promise(function (resolve, reject) {
        execFile("git", gitArguments, { "cwd": repositoryPath }, function (error, stdout, stderr) {
            if (error) {
                reject(new Error(`git ${gitArguments.join(" ")} failed: ${stderr.trim()}`));
            } else {
                resolve(stdout);
            }
        });
    });
}

// Create a fresh empty repository in the OS temp dir with a deterministic local identity,
// because committing without a configured author would make the scenarios environment-dependent
async function createEmptyRepository() {
    const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "volatility-repo-"));
    await git(repositoryPath, ["init", "-b", "main"]);
    await git(repositoryPath, ["config", "user.email", "volatility-test@example.com"]);
    await git(repositoryPath, ["config", "user.name", "Volatility Test"]);
    return repositoryPath;
}

// Commit one revision touching the given relative file paths:
// each file is created if missing or appended if already present,
// so every listed file is genuinely modified by the revision
async function commitRevision(repositoryPath, revisionLabel, filePaths) {
    for (const filePath of filePaths) {
        const absoluteFilePath = path.join(repositoryPath, filePath);
        fs.mkdirSync(path.dirname(absoluteFilePath), { "recursive": true });
        const previousContent = fs.existsSync(absoluteFilePath) ? fs.readFileSync(absoluteFilePath, "utf8") : "";
        fs.writeFileSync(absoluteFilePath, previousContent + `change ${revisionLabel}\n`);
    }
    await git(repositoryPath, ["add", "-A"]);
    await git(repositoryPath, ["commit", "-m", revisionLabel]);
}

//=====================
// Given steps: repository fixtures
//======================

// Build a real repository whose history matches the doc string.
// Doc string format, one line per revision:  "r1: path/a.js, path/b.js"
Given("a project with the following git history:", async function (historyDocString) {
    this.repoPath = await createEmptyRepository();

    const historyLines = historyDocString
        .split("\n")
        .map(function (line) {
            return line.trim();
        })
        .filter(function (line) {
            return line !== "";
        });

    for (const historyLine of historyLines) {
        const separatorIndex = historyLine.indexOf(":");
        const revisionLabel = historyLine.slice(0, separatorIndex).trim();
        const filePaths = historyLine
            .slice(separatorIndex + 1)
            .split(",")
            .map(function (filePath) {
                return filePath.trim();
            })
            .filter(function (filePath) {
                return filePath !== "";
            });
        await commitRevision(this.repoPath, revisionLabel, filePaths);
    }
});

// A repository with no commits at all: the "no changes in range" condition
Given("a project with no git commits", async function () {
    this.repoPath = await createEmptyRepository();
});

//=====================
// When steps: open the volatility view
//======================

// The volatility view is the fileVolatility service itself (plain data in, plain data out),
// which is exactly what a future HTTP route would render
When("I open the file volatility view", async function () {
    this.volatilityResult = await fileVolatilityService({ "repoPath": this.repoPath });
});

// Restrict the view to the last N revisions: git range HEAD~N..HEAD selects exactly those N commits
When("I open the file volatility view for the last {int} revisions", async function (revisionCount) {
    this.volatilityResult = await fileVolatilityService({
        "repoPath": this.repoPath,
        "range": `HEAD~${revisionCount}..HEAD`
    });
});

//=====================
// Then steps: volatility assertions
//======================

// The whole list must match in content, values AND order:
// this single step verifies the relative path, the change count and the ranking at once
Then("the volatility list should contain exactly these files in order:", function (dataTable) {
    const expectedFiles = dataTable.hashes().map(function (row) {
        return {
            "path": row["path"],
            "changes": Number(row["changes"])
        };
    });
    assert.deepStrictEqual(this.volatilityResult.files, expectedFiles);
});

Then("the volatility list should be empty", function () {
    assert.deepStrictEqual(this.volatilityResult.files, []);
});

Then("the volatility result should contain an explicit message", function () {
    assert.strictEqual(typeof this.volatilityResult.message, "string");
    assert.ok(this.volatilityResult.message.length > 0);
});

//=====================
// cleanup
//======================

After(function () {
    // Remove the temporary repository of the scenario that just ran
    if (this.repoPath) {
        fs.rmSync(this.repoPath, { "recursive": true, "force": true });
    }
});
