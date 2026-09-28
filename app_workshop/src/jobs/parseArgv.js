//=====================
// parse argv job
// Single action: turn command line arguments of the form
//   node cli/run.js <service> [--key=value ...]
// into a plain object, validating that the requested service exists.
// Returns the service name plus its arguments; the caller loads and
// invokes the service (service discovery is the entrypoint's concern).
//======================
"use strict";

/**
 * @param {Object} payload
 * @param {string[]} payload.availableServices names of the services found in src/services
 * @param {string[]} payload.argv full process.argv (node, script, service, flags)
 *
 * @return {Promise<{service_name: string, service_args: Object}>}
 */
module.exports = async function (payload) {

    // argv[0] is the node binary and argv[1] the script path, so the service name starts at index 2
    const positionalArguments = payload.argv.slice(2);
    const serviceName = positionalArguments[0];

    //=====================
    // service name validation
    // Fail fast with an actionable message instead of requiring an unknown module
    //======================
    if (!serviceName) {
        throw new Error("missing service name. usage: node cli/run.js <service> [--key=value]");
    }
    if (!payload.availableServices.includes(serviceName)) {
        throw new Error(`unknown service "${serviceName}". available services: ${payload.availableServices.join(", ")}`);
    }

    //=====================
    // --key=value flags
    // Only this flag format is supported; anything else is a caller error
    //======================
    const serviceArguments = {};
    for (const flagArgument of positionalArguments.slice(1)) {
        const separatorIndex = flagArgument.indexOf("=");
        if (!flagArgument.startsWith("--") || separatorIndex === -1) {
            throw new Error(`invalid argument "${flagArgument}". expected format: --key=value`);
        }
        serviceArguments[flagArgument.slice(2, separatorIndex)] = flagArgument.slice(separatorIndex + 1);
    }

    return {
        "service_name": serviceName,
        "service_args": serviceArguments
    };
};
