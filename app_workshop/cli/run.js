//=====================
// CLI entrypoint
// Lives outside /src on purpose: /src holds domain logic only.
// It discovers the services in src/services, parses the command line,
// and prints the service result as JSON. The same services can later be
// bound to HTTP routes without any change to the service code.
//
// The --key=value flags are passed to the service untouched, so each flag
// name is exactly a key of that service's input contract.
//
// Usage:
//   node cli/run.js fileVolatility --repoPath=/path/to/repo
//   node cli/run.js fileVolatility --repoPath=/path/to/repo --range=HEAD~2..HEAD
//======================
"use strict";

const path = require("node:path");
const process = require("node:process");
const { readdir } = require("node:fs/promises");

const servicesDirectory = path.resolve(process.cwd(), "src", "services");
const parseArgvJob = require(path.resolve(process.cwd(), "src", "jobs", "parseArgv"));

async function main() {

    try {

        //=====================
        // service discovery
        // Every file in src/services is a callable service, by design
        //======================
        const availableServices = (await readdir(servicesDirectory)).map(function (serviceFile) {
            return path.parse(serviceFile).name;
        });

        // Parse the command line and match it against a known service
        const payload = await parseArgvJob({
            "availableServices": availableServices,
            "argv": process.argv
        });

        //=====================
        // service execution
        // The require is intentionally dynamic: the service name comes
        // from the command line and was validated by parseArgv
        //======================
        const service = require(path.resolve(servicesDirectory, payload.service_name));
        const data = await service(payload.service_args);

        // The service result is the CLI contract: plain JSON on stdout
        if (data) {
            console.log(JSON.stringify(data, null, 2));
        }

        // Set the exit code instead of calling process.exit, so stdout is guaranteed to be flushed
        process.exitCode = 0;
    } catch (error) {
        // Errors are reported as JSON too, so machine consumers get a stable format
        console.log(JSON.stringify({
            "status": "ERROR",
            "message": error.message
        }, null, 2));
        process.exitCode = 1;
    }
}

main();
