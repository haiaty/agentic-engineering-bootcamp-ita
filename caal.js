#!/usr/bin/env node
/*
 * caal.js— single-file orchestrator for the user-story implementation workflow.
 *
 * It is a CONDUCTOR, not the worker:
 *   - deterministic actions (scaffolding, toml/progress bookkeeping, server restart,
 *     running tagged tests) are performed directly.
 *   - creative actions (decompose, write gherkin, implement code/step-defs, debug,
 *     generate openapi) are delegated to a pluggable agent command. With no agent
 *     configured they BLOCK with a written prompt rather than fake work.
 *
 * The task tree expands from real artifacts on disk: features are discovered from the
 * feature_*.md files produced, scenarios from the .feature file written. Nothing faked.
 *
 * Commands:
 *   node caal.jsstart --user_stories_file <path> --user_story_to_run <number>
 *                          [--agent "<cmd>"] [--base-prompt <file>] [--warmup <sec>] [--max-retries <n>]
 *                          [--human_in_the_loop true]
 *                          # extracts the requested user-story section from <user_stories_file> into
 *                          # specs/user_story_XXX/USXXX.md (appending the dev block from
 *                          # docs/user_story_template.md), then runs the workflow.
 *                          # --human_in_the_loop pauses every step for review at three gates:
 *                          # before each task starts (1=execute, 2=skip and leave pending,
 *                          # 3=mark done and continue, 4=stop the run); after the agent
 *                          # composes the task prompt (so you can read/edit it before execution);
 *                          # and after the step finishes (so you can decide whether to continue).
 *   node caal.jsstep [<task.key>]   # run exactly one action — the next actionable
 *                                        # task by default, or the named task. When a
 *                                        # task key is supplied and the workflow is in
 *                                        # completed state the runner prompts the user
 *                                        # to confirm before executing.
 *   node caal.jsrun         # run autonomously to the end (or until stop/block/fail)
 *   node caal.jsresume      # sanitize + run to the end
 *   node caal.jsstatus      # print progress (read-only, works anytime)
 *   node caal.jsstop        # request a cooperative halt at the next action boundary
 *   node caal.jsreset [--yes]
 *
 * Agent contract: the configured command is spawned with env WORKFLOW_PROMPT_FILE
 * (path to a per-step meta-prompt), WORKFLOW_TASK (the task key), and
 * WORKFLOW_COMPOSED_PROMPT_FILE (path where the agent must write the task-specific
 * prompt it composed before executing). Exit 0 = success.
 *
 * Prompt construction: per-task prompts are not built from a hard-coded template.
 * Instead, the workflow writes a thin meta-prompt that points the agent at a base
 * prompt file (configurable via --base-prompt / env WORKFLOW_BASE_PROMPT_FILE; default
 * WORKFLOW_BASE_PROMPT). The agent reads that base file, reasons about the best
 * task-specific prompt, writes that composed prompt to .workflow/prompts/<key>.composed.md
 * (so it can be reviewed/reused later), and then executes the task using it.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { StringDecoder } = require('string_decoder');

const ROOT = process.cwd();
const WF_DIR = path.join(ROOT, '.workflow');
const STATE_FILE = path.join(WF_DIR, 'state.json');
const LOCK_FILE = path.join(WF_DIR, 'lock');
const CONTROL_FILE = path.join(WF_DIR, 'control.json');
const PROMPTS_DIR = path.join(WF_DIR, 'prompts');
const RESULTS_DIR = path.join(WF_DIR, 'results');

const STORIES_TOML = path.join(ROOT, 'user_stories.toml');
const PROGRESS = path.join(ROOT, 'progress.txt');
const LEARNED = path.join(ROOT, 'learned.md');
const ERRORS = path.join(ROOT, 'error_memories.md');

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_WARMUP_MS = 8000;
const MAX_SCENARIOS = 3;

//=====================
// Agent-watch defaults
// DEFAULT_AGENT_IDLE_TIMEOUT_MS: how long we let the agent go without emitting
//   any output before we conclude it has hung and kill it. 0 disables the
//   watchdog so agents with legitimate long silent stretches are not affected.
// AGENT_KILL_GRACE_MS: how long we wait between SIGTERM and SIGKILL when
//   tearing down the agent's process group. MCP servers sometimes ignore
//   SIGTERM; this guarantees a bounded shutdown.
//=====================
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 0;
const AGENT_KILL_GRACE_MS = 5000;

//=====================
// Signal-to-exit-code map
// Used when the agent process dies from a signal we did not initiate. Mirrors
// the conventional shell rule of 128 + signal number, so error messages match
// what a user would see if they ran the agent command by hand.
//=====================
const SIGNAL_TO_EXIT = {
    SIGHUP: 129,
    SIGINT: 130,
    SIGQUIT: 131,
    SIGABRT: 134,
    SIGKILL: 137,
    SIGSEGV: 139,
    SIGPIPE: 141,
    SIGTERM: 143,
};

//=====================
// WORKFLOW_BASE_PROMPT — default path to the base prompt file
// Used as a reference when constructing per-task prompts. The agent reads this
// file to learn project conventions, references, and rules, then reasons over
// it to compose the best task-specific prompt before executing the task.
// Override per-run with --base-prompt <file> or env WORKFLOW_BASE_PROMPT_FILE.
//=====================
const WORKFLOW_BASE_PROMPT = path.join(ROOT, 'RALPH_PROMPT_NEW_USER_STORY.md');

let state = null;       // in-memory canonical state
let STOP = false;       // in-process stop flag (SIGINT)
let sigints = 0;

/* ----------------------------- small helpers ------------------------------ */

function now() { return new Date().toISOString(); }
function die(msg) { console.error('error: ' + msg); releaseLock(); process.exit(1); }
function log(msg) { console.log(msg); }
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
function readSafe(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } }
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function tomlStr(s) { return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"'); }
function sleepSync(ms) {
    if (ms <= 0) return;
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// ANSI color helpers (red for errors). Only used on the console — files stay plain.
// Auto-disable when not a TTY (e.g. piped/redirected) unless FORCE_COLOR is set,
// and honor NO_COLOR per https://no-color.org/.
const COLOR_ENABLED =
    !process.env.NO_COLOR &&
    (process.env.FORCE_COLOR === '1' || process.stdout.isTTY === true);
const C_RED = COLOR_ENABLED ? '\x1b[31m' : '';
const C_RED_BOLD = COLOR_ENABLED ? '\x1b[1;31m' : '';
const C_YELLOW = COLOR_ENABLED ? '\x1b[33m' : '';
const C_YELLOW_BOLD = COLOR_ENABLED ? '\x1b[1;33m' : '';
const C_RESET = COLOR_ENABLED ? '\x1b[0m' : '';
function logRed(msg) { console.log(C_RED + msg + C_RESET); }
function logRedBold(msg) { console.log(C_RED_BOLD + msg + C_RESET); }
function logYellow(msg) { console.log(C_YELLOW + msg + C_RESET); }
function logYellowBold(msg) { console.log(C_YELLOW_BOLD + msg + C_RESET); }
function logErrorBlock(header, body) {
    logRedBold(header);
    for (const line of String(body || '').split('\n')) logRed('    ' + line);
}

// Reasons commonly behind non-zero shell exit codes. Helps the user debug without
// having to memorize the POSIX/Bash exit-code conventions.
const EXIT_CODE_REASONS = {
    1: 'general error (command returned failure)',
    2: 'misuse of shell builtins / invalid argument',
    126: 'command found but not executable (permission denied or not an executable file)',
    127: 'command not found (typo in agent command, missing PATH entry, or missing binary)',
    128: 'invalid argument passed to exit',
    129: 'terminated by SIGHUP (hangup)',
    130: 'terminated by SIGINT (Ctrl-C)',
    131: 'terminated by SIGQUIT',
    134: 'terminated by SIGABRT (process called abort())',
    137: 'terminated by SIGKILL (out-of-memory killer or kill -9)',
    139: 'terminated by SIGSEGV (segmentation fault)',
    141: 'terminated by SIGPIPE (broken pipe — downstream reader closed)',
    143: 'terminated by SIGTERM',
};
function describeExitStatus(status, signal) {
    if (signal) return `terminated by signal ${signal}`;
    if (status === null || status === undefined) return 'process did not return an exit code';
    return EXIT_CODE_REASONS[status] || `exit code ${status} (no standard meaning — check the agent's own logs)`;
}

// ANSI-strip a string for substring matching in suggestion heuristics. We keep
// the raw tail in error_details (user may want to see colors when reading the
// memory) but match against the cleaned form so patterns like /timeout/ work.
function stripAnsi(s) { return String(s || '').replace(/\x1b\[[0-9;]*m/g, ''); }

// Map a non-zero exit code / signal to an actionable hint, when one exists.
// Returns null when nothing specific is known so callers can fall back to
// task-type-specific advice.
function suggestFixForExitCode(status, signal) {
    if (signal === 'SIGINT' || status === 130) return 'User interrupted with Ctrl-C. Resume with `node worflow.js resume`.';
    if (signal === 'SIGTERM' || status === 143) return 'Process was terminated by SIGTERM. Check for an outside supervisor sending kill signals, then `node worflow.js resume`.';
    if (status === 127) return 'Command binary not found in PATH. Verify your --agent argument / AGENT_CMD env var; run `which <first-word-of-command>` to confirm the binary exists.';
    if (status === 126) return 'Command file exists but is not executable. Run `chmod +x <command-path>` and retry.';
    if (status === 137) return 'Killed by SIGKILL — usually the OOM killer. Free memory, lower concurrency, or split the prompt into smaller chunks, then `resume`.';
    if (status === 139) return 'Segmentation fault in the spawned process. Update the binary or report to its maintainer.';
    if (status === 141) return 'Broken pipe (SIGPIPE) — a downstream reader (likely the `tee` to the log file) closed early. Check disk space and that .workflow/ is writable.';
    if (status === 2) return 'The command rejected its arguments (exit code 2 = misuse). Verify the agent command accepts the args you passed and that no shell metacharacters were interpreted unexpectedly.';
    return null;
}

// Suggested fix for an agent subprocess failure. We first try exit-code-based
// hints, then sniff the log tail for well-known failure patterns, and finally
// fall back to a generic "read the log" message.
function suggestFixForAgent(status, signal, logTail) {
    const codeFix = suggestFixForExitCode(status, signal);
    if (codeFix) return codeFix;
    const tail = stripAnsi(logTail).toLowerCase();
    if (/api key|authentication|unauthorized|\b401\b/.test(tail)) {
        return 'Agent reported an auth error. Check that ANTHROPIC_API_KEY (or whichever credential the agent uses) is exported in the shell that runs worflow.js, then `resume`.';
    }
    if (/rate.?limit|\b429\b/.test(tail)) {
        return 'Agent was rate-limited. Wait a few minutes and `node worflow.js resume`, or lower concurrency.';
    }
    if (/econnreset|enotfound|network|fetch failed|getaddrinfo/.test(tail)) {
        return 'Agent hit a network error. Check connectivity and any corporate proxy settings, then `resume`.';
    }
    if (/no such file|enoent/.test(tail)) {
        return 'Agent referenced a missing file. The prompt at WORKFLOW_PROMPT_FILE expects artifacts created by prior steps — check that they exist on disk. Re-run the prior step or correct the prompt.';
    }
    if (/permission denied|eacces/.test(tail)) {
        return 'Permission denied while the agent ran. Check file ownership/perms on the files the agent edits, or run worflow.js as the right user.';
    }
    const codePart = status === null ? `signal ${signal || 'unknown'}` : `exit code ${status}`;
    return `Agent exited with ${codePart}. Read the log tail above — it contains the actual failure reason from the agent itself. Full log is available with \`tail -n200 <log_file>\`. Fix the underlying issue and \`resume\`.`;
}

// Suggested fix for a BDD test failure. Sniffs the cucumber output for
// well-known failure modes and assembles concrete remediation steps.
function suggestFixForTestFailure(logTail) {
    const tail = stripAnsi(logTail).toLowerCase();
    const hints = [];
    if (/econnrefused|connection refused/.test(tail)) {
        hints.push('Connection refused — the dev server is likely not listening. Verify `npm run start:dev` is healthy on the expected port (the workflow waits warmupMs after starting it; raise --warmup if cold start is slow).');
    }
    if (/undefined step/.test(tail) || /step is undefined/.test(tail)) {
        hints.push('Cucumber reported an undefined step. The gherkin step text does not match any step definition — compare the wording in the .feature file with the regex / cucumber-expression in tests/steps/*.');
    }
    if (/ambiguous step/.test(tail)) {
        hints.push('Ambiguous step — multiple step definitions match. Remove or tighten one of the duplicate definitions in tests/steps/*.');
    }
    if (/assertionerror|expected .* but got|expected .* to equal|expected .* to be/.test(tail)) {
        hints.push('Assertion failure — the production code or seed data does not produce the expected state. Read the assertion message, then either fix the implementation (preferred) or correct the test if it encodes the wrong expectation.');
    }
    if (/timeout|timed out/.test(tail)) {
        hints.push('A step timed out. Either an async operation is hanging (look for promises that never resolve) or the dev server is slow on cold start (raise --warmup).');
    }
    if (/syntaxerror|unexpected token|cannot find module/.test(tail)) {
        hints.push('Code did not load — likely a syntax error or missing import in files just edited. Run `node -c <file>` to validate JS files.');
    }
    if (/er_no_such_table|er_bad_field_error|er_dup_entry|deadlock|lock wait timeout|er_parse_error/.test(tail)) {
        hints.push('Database error — confirm schema is up to date (migrations applied) and that test fixtures are not colliding with existing rows. Check the audit table for stale entries.');
    }
    if (/audit/.test(tail) && /(expected|undefined|missing|not found)/.test(tail)) {
        hints.push('An audit-table assertion failed. Check that the operation under test actually writes the expected audit row (right table, right action, right payload).');
    }
    if (hints.length === 0) {
        return 'Read the cucumber output above to identify the failing step and the error message. Common roots: (1) production code does not yet implement the behavior; (2) step definition is missing or matches the wrong regex; (3) database state was not seeded; (4) audit-row assertion is querying the wrong table/column. The workflow will queue a DEBUG task on retry so the agent can diagnose. If you fix it manually, mark the failure done with `node worflow.js done <key>` after fixing.';
    }
    hints.push('After fixing, run `node worflow.js resume` — the workflow will retry the test (and queue a DEBUG task automatically if you have retries remaining).');
    return hints.join('\n');
}


//=====================
// Parse failed scenario names from cucumber test output
// Extracts scenario names from "N) Scenario: <name>" failure blocks
// Returns array of scenario name strings (empty if none found)
//=====================
function parseFailedScenarios(logText) {
    const text = stripAnsi(logText || '');
    const names = [];
    const re = /^\s*\d+\)\s+Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*#/gm;
    let m;
    while ((m = re.exec(text))) names.push(m[1].trim());
    return names;
}

//=====================
// Run cli/generatePromptForDebug.js with the provided error context
// Generates a debug prompt that combines context, request logs, and tracing data
// Returns { ok, promptPath } or { ok: false, error }
//=====================
function generateDebugPrompt(contextText) {
    const contextFile = path.join(WF_DIR, 'context_for_debug_prompt.txt');
    fs.writeFileSync(contextFile, contextText);
    const scriptPath = path.resolve(ROOT, 'cli', 'generatePromptForDebug.js');
    const cmd = `node "${scriptPath}" --context_file="${contextFile}"`;
    const r = spawnSync(cmd, { shell: '/bin/bash', stdio: 'pipe', cwd: ROOT });
    if (r.error || r.status !== 0) {
        return {
            ok: false,
            error: `generatePromptForDebug failed: ${r.error ? r.error.message : 'exit code ' + r.status}`,
        };
    }
    const promptPath = path.resolve(ROOT, 'debug_prompt.txt');
    if (!fs.existsSync(promptPath)) {
        return { ok: false, error: 'debug_prompt.txt was not generated' };
    }
    return { ok: true, promptPath };
}

function readTail(file, maxLines) {
    const txt = readSafe(file);
    if (!txt) return '';
    const trimmed = txt.replace(/\s+$/, '');
    if (!trimmed) return '';
    const lines = trimmed.split('\n');
    if (lines.length <= maxLines) return trimmed;
    return `... (${lines.length - maxLines} earlier line(s) omitted) ...\n` + lines.slice(-maxLines).join('\n');
}

function appendLine(file, line) {
    const stamp = `[${now()}] `;
    fs.appendFileSync(file, stamp + line + '\n');
}
function progress(line) { appendLine(PROGRESS, line); }
function appendError(task) {
    const indent = (s) => String(s || '').split('\n').map((l) => '  ' + l).join('\n');
    const details = task.error_details;
    let body;
    if (details && typeof details === 'object') {
        const lines = [];
        if (details.summary) lines.push(`Summary: ${details.summary}`);
        if (details.reason) lines.push(`Reason: ${details.reason}`);
        if (details.operation) lines.push(`Operation: ${details.operation}`);
        if (details.command) lines.push(`Command: ${details.command}`);
        if (details.exit_code !== undefined && details.exit_code !== null) {
            lines.push(`Exit code: ${details.exit_code}${details.exit_reason ? ` (${details.exit_reason})` : ''}`);
        }
        if (details.signal) lines.push(`Signal: ${details.signal}`);
        if (details.log_file) lines.push(`Log: ${details.log_file}`);
        if (details.prompt_file) lines.push(`Prompt: ${details.prompt_file}`);
        if (details.scenario) lines.push(`Scenario: ${details.scenario}`);
        if (details.feature_number !== undefined && details.feature_number !== null) {
            lines.push(`Feature #: ${details.feature_number}`);
        }
        if (details.story_tag) lines.push(`Story tag: ${details.story_tag}`);
        if (details.artifacts_checked && details.artifacts_checked.length) {
            lines.push(`Artifacts checked: ${details.artifacts_checked.join(', ')}`);
        }
        if (Array.isArray(details.files_found)) {
            lines.push(`Files found at that path: ${JSON.stringify(details.files_found)}`);
        }
        if (details.log_tail) {
            lines.push('Log tail:');
            lines.push(indent(details.log_tail));
        }
        if (details.stack_trace) {
            lines.push('Stack trace:');
            lines.push(indent(details.stack_trace));
        }
        if (details.suggested_fix) {
            lines.push('Suggested fix:');
            lines.push(indent(details.suggested_fix));
        }
        body = indent(lines.join('\n'));
    } else {
        body = indent(String(task.error || 'unknown'));
    }
    const block = `[${now()}] Task ${task.key} (${task.type}) failed after ${task.attempts} attempt(s):\n${body}\n\n`;
    fs.appendFileSync(ERRORS, block);
}

/* -------------------------------- tracing --------------------------------- */
// CSV trace log at .workflow/trace.csv. Always on; wiped by `reset` along with
// the rest of .workflow/. Tracing must never break the workflow — all errors
// inside emitTrace are swallowed.

const TRACE_CSV = path.join(WF_DIR, 'trace.csv');
const TRACE_HEADER = '"timestamp_ms","datetime","event_label","payload"\n';

function _csvField(v) {
    const s = String(v == null ? '' : v);
    return '"' + s.replace(/"/g, '""') + '"';
}

function _traceDatetime() {
    const d = new Date();
    const pad = (n, w) => String(n).padStart(w, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ` +
        `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

function emitTrace(traceLabel, traceData) {
    try {
        ensureDir(WF_DIR);
        let data = traceData == null ? {} : traceData;
        if (data instanceof Error) {
            data = { name: data.name, message: data.message, stack: data.stack, code: data.code };
        }
        const payload = JSON.stringify(data, (key, value) =>
            typeof value === 'bigint' ? Number(value) : value);
        const row = [
            _csvField(Date.now()),
            _csvField(_traceDatetime()),
            _csvField(traceLabel),
            _csvField(payload),
        ].join(',') + '\n';
        if (!fs.existsSync(TRACE_CSV)) fs.appendFileSync(TRACE_CSV, TRACE_HEADER);
        fs.appendFileSync(TRACE_CSV, row);
    } catch { /* tracing must never break the workflow */ }
}

/* --------------------------------- state ---------------------------------- */

function persist() {
    if (!state) return;
    state.updatedAt = now();
    ensureDir(WF_DIR);
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}
function loadState() {
    const raw = readSafe(STATE_FILE);
    if (!raw) return false;
    state = JSON.parse(raw);
    return true;
}

function makeTask(key, type, title, kind, meta) {
    return {
        key, type, title, kind,
        status: 'pending',
        attempts: 0,
        maxAttempts: DEFAULT_MAX_ATTEMPTS,
        meta: meta || {},
        error: null,
        error_details: null,
        startedAt: null,
        finishedAt: null,
    };
}

// Helper to assemble a consistent error_details object. Callers pass only the
// fields that apply to their failure mode — undefined fields are dropped.
function makeErrorDetails(task, fields) {
    const base = {
        task: {
            key: task.key,
            type: task.type,
            kind: task.kind,
            attempt: task.attempts,
            max_attempts: task.maxAttempts,
        },
        failed_at: now(),
    };
    const out = { ...base, ...fields };
    for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
    return out;
}

/* ------------------------------ story parsing ----------------------------- */

function parseStory(file) {
    const md = readSafe(file);
    if (md === null) die('story file not found: ' + file);
    const m =
        md.match(/US[-_ ]?(\d{1,4})/i) ||
        file.match(/US[-_ ]?(\d{1,4})/i) ||
        file.match(/user_story_(\d{1,4})/i);
    if (!m) die('could not determine the user story number (expected something like "US-007").');
    const number = m[1];
    const headingMatch = md.match(/^#{1,6}\s*(.+?)\s*$/m);
    let title = headingMatch ? headingMatch[1].replace(/^US[-_ ]?\d+\s*[—\-:]*\s*/i, '').trim() : '';
    if (!title) title = `User story ${number}`;
    const padded = String(number).padStart(3, '0');
    return {
        id: `US-${number}`,
        number,
        padded,
        title,
        tag: `@US${padded}`,
        sourceFile: path.relative(ROOT, path.resolve(file)) || file,
        status: 'pending',
    };
}

//=====================
// normalizeStoryNumber
// Accepts the user-supplied story identifier (e.g. "19", "019", "US-019") and
// returns the canonical 3-digit padded string used everywhere downstream for
// folder names, file names, and section lookup. Dies fast on garbage input so
// the user gets an immediate error instead of a confusing "section not found"
// later in bootstrap.
//=====================
function normalizeStoryNumber(input) {
    const m = String(input == null ? '' : input).match(/(\d{1,4})/);
    if (!m) die('invalid user story number: ' + input);
    return String(m[1]).padStart(3, '0');
}

//=====================
// extractStorySection
// Locates `### US-<paddedNumber>` inside the full user-stories markdown file
// and returns the title plus the verbatim markdown for that single story
// (everything up to but not including the next `### US-` heading or EOF).
// Trailing `---` separators and blank lines are trimmed so the section can be
// concatenated cleanly with the template dev block.
//=====================
function extractStorySection(storiesFile, paddedNumber) {
    const text = readSafe(storiesFile);
    if (text === null) die('user stories file not found: ' + storiesFile);
    const lines = text.split('\n');
    const headingRe = /^###\s+US-(\d{1,4})\b/i;

    let startIdx = -1;
    let title = `User story ${paddedNumber}`;
    for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(headingRe);
        if (m && String(m[1]).padStart(3, '0') === paddedNumber) {
            startIdx = i;
            const headerMatch = lines[i].match(/^###\s+US-\d+\s*[—\-:]?\s*(.*?)\s*$/i);
            if (headerMatch && headerMatch[1]) title = headerMatch[1].trim();
            break;
        }
    }
    if (startIdx === -1) {
        die(`could not find user story US-${paddedNumber} in ${storiesFile}`);
    }

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
        if (headingRe.test(lines[i])) { endIdx = i; break; }
    }

    const sectionLines = lines.slice(startIdx, endIdx);
    while (sectionLines.length > 0) {
        const last = sectionLines[sectionLines.length - 1].trim();
        if (last === '' || /^-{3,}$/.test(last)) { sectionLines.pop(); continue; }
        break;
    }
    return { title, sectionText: sectionLines.join('\n') };
}

//=====================
// extractTemplateDevPart
// Reads the user-story template file and returns everything from the `----`
// separator that introduces the "(the part below should be compiled by devs)"
// marker through end-of-file. The separator line is preserved so the resulting
// USXXX.md file keeps the same visual boundary as the template.
//=====================
function extractTemplateDevPart(templateFile) {
    const text = readSafe(templateFile);
    if (text === null) die('user story template file not found: ' + templateFile);
    const markerRe = /-{2,}\s*\r?\n\s*\(the part below should be compiled by devs\)/i;
    const m = markerRe.exec(text);
    if (!m) die(`could not find "(the part below should be compiled by devs)" marker in ${templateFile}`);
    return text.slice(m.index);
}

//=====================
// setupStorySpecFile
// Creates specs/user_story_XXX/ (if missing) and writes the per-story spec
// file specs/user_story_XXX/USXXX.md by concatenating the extracted user-story
// section with the template's dev block. Always overwrites: this is invoked
// only from bootstrap (a fresh workflow start), and starting fresh implies the
// previous spec is obsolete. Returns the absolute path to USXXX.md.
//=====================
function setupStorySpecFile(paddedNumber, sectionText, devPart) {
    const dir = path.join(ROOT, 'specs', `user_story_${paddedNumber}`);
    ensureDir(dir);
    const file = path.join(dir, `US${paddedNumber}.md`);
    const body = sectionText.replace(/\s+$/, '') + '\n\n\n' + devPart.replace(/^\s+/, '');
    fs.writeFileSync(file, body);
    return file;
}

function storyDir() { return path.join(ROOT, 'specs', `user_story_${state.story.number}`); }
function sharedFile() { return path.join(storyDir(), 'shared_across_features.md'); }
function featureSpec(n) { return path.join(storyDir(), `feature_${n}.md`); }

/* ---------------------------- task-tree building -------------------------- */

function backbone() {

    let backboneTasks =  [
        //=====================
        // story.complete_dev_parts — first task on every start.
        // The `start` command has already scaffolded specs/user_story_XXX/USXXX.md
        // by concatenating the extracted user-story section with the template
        // dev block. This task delegates to the agent to populate the dev block
        // (non_functional_specifications, api_endpoints, implementation_details_*,
        // user-flow http calls, data_model, etc.) based on the user-story content
        // above the marker, before the rest of the workflow proceeds.
        //=====================
        makeTask('story.complete_dev_parts', 'COMPLETE_DEV_PARTS', 'Complete dev sections of the user-story spec', 'agent', {}),
        makeTask('story.mark_in_progress', 'MARK_STORY_IN_PROGRESS', 'Mark story in progress', 'deterministic', {}),
        makeTask('story.decompose', 'DECOMPOSE_FEATURES', 'Decompose story into features', 'agent', {}),
        makeTask('story.expand_features_tasks', 'EXPAND_FEATURE_GROUPS', 'Generate tasks to be done for every feature', 'deterministic', {}),
        // feature groups get spliced in here, after story.generate_bdd_tests runs
        //makeTask('story.full_suite', 'RUN_FULL_SUITE', 'Run full test suite for the story', 'deterministic', {}),
        makeTask('story.openapi', 'GEN_OPENAPI', 'Generate / update server/schema.json', 'agent', {}),
        makeTask('story.mark_completed', 'MARK_STORY_COMPLETED', 'Mark story completed', 'deterministic', {}),
        makeTask('story.finish', 'FINISH', 'Finalize and announce completion', 'deterministic', {}),
    ];

    const backboneTasksSummary = backboneTasks.map(t => ({ key: t.key, type: t.type }));
    emitTrace('[info] default tasks - backbone', { backboneTasks: backboneTasksSummary });

    return backboneTasks;
}

function featureGroup(n) {
    return [
        makeTask(`feature_${n}.gherkin`, 'CREATE_GHERKIN', `Feature ${n}: write gherkin (<=3 scenarios)`, 'agent', { featureNum: n }),
        //makeTask(`feature_${n}.code`, 'IMPL_CODE', `Feature ${n}: write production code`, 'agent', { featureNum: n }),
        // scenario groups get spliced in here, after gherkin runs
        //makeTask(`feature_${n}.unit_tests`, 'UNIT_TESTS', `Feature ${n}: unit tests for jobs/operations`, 'agent', { featureNum: n }),
        makeTask(`feature_${n}.mark_done`, 'MARK_FEATURE_DONE', `Feature ${n}: mark done`, 'deterministic', { featureNum: n }),
    ];
}

function scenarioGroup(n, m, name) {
    const base = `feature_${n}.scenario_${m}`;
    return [
        makeTask(`${base}.impl_code`, 'IMPL_CODE', `F${n} S${m}: implement production code`, 'agent', { featureNum: n, scenarioNum: m, scenarioName: name }),
        makeTask(`${base}.impl_stepdefs`, 'IMPL_STEPDEFS', `F${n} S${m}: implement step definitions`, 'agent', { featureNum: n, scenarioNum: m, scenarioName: name }),
        makeTask(`${base}.run_test`, 'RUN_TEST', `F${n} S${m}: run scenario test`, 'deterministic', { featureNum: n, scenarioNum: m, scenarioName: name, baseKey: base, retry: 0 }),
    ];
}

function spliceAfter(tasks, key, newTasks) {
    const i = tasks.findIndex((t) => t.key === key);
    if (i < 0) tasks.push(...newTasks);
    else tasks.splice(i + 1, 0, ...newTasks);
}

/* --------------------------- artifact discovery --------------------------- */

function discoverFeatures() {
    const dir = storyDir();
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .map((f) => (f.match(/^feature_(\d+)\.md$/) || [])[1])
        .filter(Boolean)
        .map((x) => parseInt(x, 10))
        .sort((a, b) => a - b);
}

//=====================
// discoverScenariosAt
// Scan a .feature file at an arbitrary absolute path for `Scenario:` and
// `Scenario Outline:` declarations. Replaces the old discoverScenarios(n)
// which assumed a hardcoded `tests/features/usXXX_feature_N.feature` path —
// CREATE_GHERKIN now learns the actual path from the agent's result JSON
// (which respects the bdd-gherkin-feature-writer skill's domain-based
// organization, e.g. `tests/features/<domain>/<capability>.feature`).
//=====================
function discoverScenariosAt(filePath) {
    const txt = readSafe(filePath);
    if (!txt) return [];
    const names = [];
    const re = /^\s*Scenario(?:\s+Outline)?\s*:\s*(.+?)\s*$/gm;
    let m;
    while ((m = re.exec(txt))) names.push(m[1]);
    return names.slice(0, MAX_SCENARIOS);
}

/* ------------------------------- toml mgmt -------------------------------- */

function hasStory(id) {
    const t = readSafe(STORIES_TOML);
    return !!t && new RegExp(`id\\s*=\\s*"${escapeRe(id)}"`).test(t);
}
function ensureStoriesToml(story) {
    if (!fs.existsSync(STORIES_TOML)) {
        fs.writeFileSync(STORIES_TOML, '# user stories registry — managed by workflow.js\n');
    }
    if (hasStory(story.id)) return;
    let t = readSafe(STORIES_TOML) || '';
    if (t && !t.endsWith('\n')) t += '\n';
    const block =
        `\n[[story]]\n` +
        `id = "${story.id}"\n` +
        `title = "${tomlStr(story.title)}"\n` +
        `done = false\n` +
        `in_progress = false\n` +
        `user_story_source_file = "${tomlStr(story.sourceFile)}"\n`;
    fs.writeFileSync(STORIES_TOML, t + block);
}
function setStoryFlag(id, key, value) {
    let t = readSafe(STORIES_TOML);
    if (!t) return;
    const blocks = t.split(/(?=\[\[story\]\])/g);
    for (let i = 0; i < blocks.length; i++) {
        if (!new RegExp(`id\\s*=\\s*"${escapeRe(id)}"`).test(blocks[i])) continue;
        if (new RegExp(`^\\s*${key}\\s*=`, 'm').test(blocks[i])) {
            blocks[i] = blocks[i].replace(new RegExp(`^(\\s*${key}\\s*=\\s*).*$`, 'm'), `$1${value}`);
        } else {
            blocks[i] = blocks[i].replace(/\n*$/, `\n${key} = ${value}\n`);
        }
    }
    fs.writeFileSync(STORIES_TOML, blocks.join(''));
}

/* ------------------------------ agent runner ------------------------------ */

//=====================
// resolveAgentCmd — pick the agent command for a given task.
// Precedence: per-step override (state.config.stepAgents[task.key]) > global
// (state.config.agentCmd) > none. Returns { cmd, source } so the caller can
// log/trace which one was used. A null cmd means no agent is configured and
// the runner should block (or be told to fail) with a written prompt.
//=====================
function resolveAgentCmd(task) {
    const overrides = (state && state.config && state.config.stepAgents) || {};
    if (task && task.key && overrides[task.key]) {
        return { cmd: overrides[task.key], source: 'step-override' };
    }
    return { cmd: (state && state.config && state.config.agentCmd) || null, source: 'global' };
}

//=====================
// renderResultReportingSection — build the prompt block that tells the agent
// to write a JSON result file at the end of the task.
//
// Returns a string section ready to splice into the prompt, or null when the
// caller did not pass a resultSpec (most tasks have no structured result
// channel). The section explains:
//   - the absolute target path AND the env var (WORKFLOW_RESULT_FILE) the agent
//     can use interchangeably;
//   - the list of required keys, with per-key descriptions when supplied;
//   - the hard-fail policy if the file is missing, malformed, or incomplete.
//
// resultSpec shape:
//   { required: ['gherkin_path', ...], schema: { gherkin_path: 'description', ... } }
//=====================
function renderResultReportingSection(resultSpec, resultFilePath) {
    if (!resultSpec || !resultFilePath) return null;
    const resultRel = path.relative(ROOT, resultFilePath) || resultFilePath;
    const required = Array.isArray(resultSpec.required) ? resultSpec.required : [];
    const schemaLines = [];
    if (resultSpec.schema && typeof resultSpec.schema === 'object') {
        for (const [key, desc] of Object.entries(resultSpec.schema)) {
            schemaLines.push(`- \`${key}\`: ${desc}`);
        }
    }
    const exampleObj = {};
    for (const k of required) exampleObj[k] = '<value>';
    const lines = [
        `## Result reporting (MANDATORY)`,
        `After producing every other artifact this task requires, you MUST write a JSON object to this exact path:`,
        ``,
        `  \`${resultRel}\``,
        ``,
        `The same path is also available in the env var \`WORKFLOW_RESULT_FILE\` — use whichever you prefer.`,
        ``,
        `This file is the structured handoff between you and the workflow orchestrator and is NOT optional.`,
        `If you exit without writing it, write invalid JSON, or omit any required key, the workflow step will FAIL HARD with no retry-by-context — the orchestrator cannot recover from a missing handoff.`,
        ``,
        `Required keys: ${required.map((k) => `\`${k}\``).join(', ') || '(none)'}`,
    ];
    if (schemaLines.length) {
        lines.push('', 'Schema:', ...schemaLines);
    }
    lines.push(
        '',
        'Example shape:',
        '```json',
        JSON.stringify(exampleObj, null, 2),
        '```',
        '',
        'Write this file LAST, AFTER every other artifact the task requires is on disk. Use the Write tool.',
    );
    return lines.join('\n');
}

//=====================
// renderPrompt — build the meta-prompt sent to the agent.
// `phase` selects which orchestration shape the prompt enforces:
//   - 'full'    : single-shot — compose the task prompt AND execute (default).
//   - 'compose' : compose-only (used as phase 1 of human-in-the-loop). The
//                 agent must write the composed prompt and exit without acting.
//   - 'execute' : execute-only (phase 2 of human-in-the-loop). The agent reads
//                 the human-approved composed prompt and runs the task,
//                 without re-composing.
// The base-prompt reference, story metadata, and task instructions are shared
// across phases so the agent always knows the project conventions and the
// task at hand; only the procedure and required-outputs sections change.
//
// resultSpec / resultFilePath: when both are provided AND the phase actually
// executes the task ('execute' or 'full'), a "Result reporting" section is
// appended to the prompt instructing the agent to write a JSON handoff file.
// The compose phase never includes this section because nothing is executed
// there — the result file belongs to the execute step.
//=====================
function renderPrompt(task, instructions, composedPromptPath, phase, resultSpec, resultFilePath) {
    phase = phase || 'full';
    const basePromptAbs = state.config.basePromptFile;
    const basePromptRel = path.relative(ROOT, basePromptAbs) || basePromptAbs;
    const basePromptExists = fs.existsSync(basePromptAbs);
    const composedPromptRel = path.relative(ROOT, composedPromptPath) || composedPromptPath;

    //=====================
    // Base-prompt status line
    // If the configured file is missing we still emit a usable prompt and tell
    // the agent so — failing here would block the entire workflow on a file
    // the agent itself might be expected to create on the first run.
    //=====================
    const basePromptStatus = basePromptExists
        ? `A base prompt file is available at \`${basePromptRel}\`. Read it first — it contains the project conventions, rules, references, and shared context that every prompt in this workflow must respect.`
        : `WARNING: the configured base prompt file at \`${basePromptRel}\` does not exist on disk. If you can create it from project documentation (AGENTS.md, docs/architecture/, specs/) do so; otherwise proceed using your best judgment about the project conventions.`;

    if (phase === 'compose') {
        return [
            `# Workflow task: ${task.title} — COMPOSE PHASE (human-in-the-loop)`,
            `task key: ${task.key}`,
            ``,
            `You are running in human-in-the-loop mode. This invocation is the COMPOSE PHASE only: author the task-specific prompt and exit. Do NOT execute the task. A human will review (and possibly edit) the composed prompt before a separate execute phase is launched.`,
            ``,
            `## Required output`,
            `1. **Composed prompt file** at \`${composedPromptRel}\` — the task-specific prompt you authored, written verbatim. This is the only deliverable for this phase.`,
            ``,
            `If you exit without writing that file the workflow step has FAILED.`,
            ``,
            `## Reference materials`,
            basePromptStatus,
            `- User story: ${state.story.id} — ${state.story.title}`,
            `- Story source file: ${state.story.sourceFile}`,
            `- Scenario tag for this story: ${state.story.tag}`,
            ``,
            `## Task description (compose a prompt for this task — do NOT act on it now)`,
            instructions,
            ``,
            `## Procedure — follow in this exact order`,
            `1. Read \`${basePromptRel}\` and any documents it points at (AGENTS.md, architecture docs, specs, etc.) so you understand the conventions, rules, and references that apply.`,
            `2. Compose a task-specific prompt for the "Task description" above, using the base prompt as your template/reference. Tailor it — include only what is relevant; drop what is not.`,
            `3. WRITE that composed prompt verbatim to \`${composedPromptRel}\` (also available as env var WORKFLOW_COMPOSED_PROMPT_FILE) using the Write tool.`,
            `4. Exit with code 0. Do NOT execute the task. Do NOT produce code, tests, or other artifacts in this phase. A human will review your composed prompt before the execute phase begins.`,
            ``,
            `## Common failure modes to avoid`,
            `- Skipping the composed-prompt file. It is the only deliverable for this phase — without it the workflow stops.`,
            `- Acting on the task description. Executing in this phase defeats the purpose of human-in-the-loop review.`,
        ].join('\n');
    }

    if (phase === 'execute') {
        const resultSection = renderResultReportingSection(resultSpec, resultFilePath);
        const resultBlock = resultSection ? [resultSection, ``] : [];
        return [
            `# Workflow task: ${task.title} — EXECUTE PHASE (human-in-the-loop)`,
            `task key: ${task.key}`,
            ``,
            `You are running in human-in-the-loop mode. This invocation is the EXECUTE PHASE: a human has reviewed (and possibly edited) the previously composed prompt and approved it for execution. Read that composed prompt and execute the task exactly as it specifies.`,
            ``,
            `## Required outputs`,
            `Every artifact the task itself requires (code, tests, files, etc.). The composed prompt at \`${composedPromptRel}\` describes them — do not re-author the prompt, just follow it.`,
            ``,
            ...resultBlock,
            `## Reference materials`,
            `- Composed prompt (authoritative for this invocation): \`${composedPromptRel}\` (also env var WORKFLOW_COMPOSED_PROMPT_FILE). This is the human-approved instruction set; treat it as final.`,
            basePromptStatus,
            `- User story: ${state.story.id} — ${state.story.title}`,
            `- Story source file: ${state.story.sourceFile}`,
            `- Scenario tag for this story: ${state.story.tag}`,
            ``,
            `## Original task description (for context — the composed prompt is authoritative)`,
            instructions,
            ``,
            `## Procedure — follow in this exact order`,
            `1. Read \`${composedPromptRel}\` carefully. A human approved it for this run; treat it as your authoritative instruction set.`,
            `2. Execute the task end-to-end per that composed prompt. Do NOT modify the composed prompt. Do NOT re-compose it.`,
            `3. Produce every artifact the task requires (code, tests, files). Verify they exist on disk.`,
            `4. Exit with code 0. Do not wait for further input, do not idle, do not keep background subprocesses attached to your stdio. The workflow orchestrator detects task completion ONLY when your process exits.`,
            ``,
            `## Common failure modes to avoid`,
            `- Overwriting \`${composedPromptRel}\` or re-composing the prompt. The human-approved prompt is final for this invocation.`,
            `- Reading the composed prompt and then stopping. Reading is preparation; executing the described work is the task.`,
        ].join('\n');
    }

    //=====================
    // 'full' phase (default) — original single-shot meta-prompt: compose the
    // task-specific prompt and execute the task in one invocation. Kept
    // unchanged from before human-in-the-loop was introduced so autonomous
    // runs preserve their previous behavior bit-for-bit.
    //=====================
    const fullResultSection = renderResultReportingSection(resultSpec, resultFilePath);
    const fullResultBlock = fullResultSection ? [fullResultSection, ``] : [];
    return [
        `# Workflow task: ${task.title}`,
        `task key: ${task.key}`,
        ``,
        `You are running as one step in an automated workflow. You MUST produce TWO concrete outputs on disk before you exit. Reading files and understanding the task is preparation, not completion.`,
        ``,
        `## Required outputs (both must exist before you exit)`,
        `1. **Composed prompt file** at \`${composedPromptRel}\` — the task-specific prompt you authored, written verbatim.`,
        ``,
        `If you exit with without output 1 the workflow step has FAILED.`,
        ``,
        ...fullResultBlock,
        `## Reference materials`,
        basePromptStatus,
        `- User story: ${state.story.id} — ${state.story.title}`,
        `- Story source file: ${state.story.sourceFile}`,
        `- Scenario tag for this story: ${state.story.tag}`,
        ``,
        `## Task description`,
        instructions,
        ``,
        `## Procedure — follow in this exact order`,
        `1. Read \`${basePromptRel}\` and any documents it points at (AGENTS.md, architecture docs, specs, etc.) so you understand the conventions, rules, and references that apply. Do NOT stop here — reading is preparation, not completion.`,
        `2. Compose a task-specific prompt for the "Task description" above, using the base prompt as your template/reference. Tailor it — include only what is relevant; drop what is not.`,
        `3. WRITE that composed prompt verbatim to \`${composedPromptRel}\` (also available as env var WORKFLOW_COMPOSED_PROMPT_FILE). This file MUST exist on disk before you move to step 4 — use the Write tool now, do not just describe what you would write.`,
        `4. Now execute the task end-to-end, using the prompt you just composed (and saved) as your guide. Produce every artifact the task requires (code, tests, files). Do NOT stop after step 3 — writing the composed prompt is not the task; it is the plan for the task.`,
        `5. Verify both required outputs exist on disk and once you have completed the task then exit with code 0. Do not wait for further input, do not idle, do not keep background subprocesses attached to your stdio, do not print a closing summary that requires user acknowledgement. The workflow orchestrator detects task completion ONLY when your process exits — if you stay running, the workflow hangs and cannot proceed to the next task.`,
        ``,
        `## Common failure modes to avoid`,
        `- Reading the reference files and then stopping. That is NOT task completion — you still owe output 1.`,
        `- Writing the composed prompt and then stopping. That is NOT task completion — you still owe every artifact the task requires (code, tests, files)..`,
        `- Treating the "Task description" section as an instruction to act on directly without first composing and saving the prompt. The composed prompt is mandatory.`,
    ].join('\n');
}

//=====================
// runAgent — entry point for delegating a task to the configured agent.
//
// resultSpec (optional) describes a structured JSON handoff the agent must
// produce. When provided, _runAgentInner injects the WORKFLOW_RESULT_FILE env
// var, the prompt gains a "Result reporting" section, and on success we
// validate the file (hard fail if missing/invalid). The parsed JSON ends up
// on the returned result as `agentResult` so the calling handler can use it.
// Pass `null` for tasks with no structured result requirement.
//=====================
async function runAgent(task, instructions, resultSpec) {
    //=====================
    // Prepare the prompt files BEFORE emitting the [running] trace so the
    // trace payload can include the generated prompt path, its content, and
    // the value that will be passed via $WORKFLOW_PROMPT_FILE to the agent.
    // The composed-prompt path is wiped here (not in _runAgentInner) so a
    // stale composed prompt from a previous attempt does not mislead reviewers.
    //=====================
    ensureDir(PROMPTS_DIR);
    const safe = task.key.replace(/[^\w.\-]/g, '_');
    const promptPath = path.join(PROMPTS_DIR, `${safe}.md`);
    const composedPromptPath = path.join(PROMPTS_DIR, `${safe}.composed.md`);
    try { fs.unlinkSync(composedPromptPath); } catch { /* fresh per invocation */ }

    //=====================
    // Result file — only allocated when this task asked for a structured JSON
    // handoff. Wiped before the run so a stale file from a previous attempt
    // cannot satisfy validation by accident.
    //=====================
    let resultFilePath = null;
    if (resultSpec) {
        ensureDir(RESULTS_DIR);
        resultFilePath = path.join(RESULTS_DIR, `${safe}.json`);
        try { fs.unlinkSync(resultFilePath); } catch { /* fresh per invocation */ }
    }

    //=====================
    // Human-in-the-loop branch (two-phase invocation)
    // When state.config.humanInTheLoop is true we split the agent run into a
    // compose-only phase, a user review gate, and an execute phase. The user
    // may edit the composed prompt file between the two phases — the execute
    // phase reads whatever is on disk after the gate. We delegate to a helper
    // so the autonomous flow below stays a single, readable code path.
    //=====================
    if (state.config && state.config.humanInTheLoop) {
        return runAgentWithHumanInTheLoop(task, instructions, promptPath, composedPromptPath, resultSpec, resultFilePath);
    }

    const promptBody = renderPrompt(task, instructions, composedPromptPath, 'full', resultSpec, resultFilePath);
    fs.writeFileSync(promptPath, promptBody);

    const { cmd: resolvedAgentCmd, source: resolvedAgentSource } = resolveAgentCmd(task);
    emitTrace('[running] runAgent', {
        inputs: {
            taskKey: task.key,
            taskType: task.type,
            command: resolvedAgentCmd,
            commandSource: resolvedAgentSource,
            prompt_generated_path: path.relative(ROOT, promptPath),
            prompt_generated: promptBody,
            WORKFLOW_PROMPT_FILE: promptPath,
            WORKFLOW_PROMPT: readSafe(promptPath),
            WORKFLOW_RESULT_FILE: resultFilePath,
            resultSpec: resultSpec || null,
        },
    });
    const result = await _runAgentInner(task, { promptPath, composedPromptPath, promptBody, resultSpec, resultFilePath });
    emitTrace('[finished] runAgent', {
        result: {
            ok: !!result.ok,
            blocked: !!result.blocked,
            hasError: !!result.error,
            error: result.error ? String(result.error).split('\n')[0] : null,
            detection: result.detection || null,
            killReason: result.killReason || null,
            agentResult: result.agentResult || null,
        },
    });
    return result;
}

//=====================
// runAgentWithHumanInTheLoop
// Two-phase orchestration triggered by the --human_in_the_loop flag:
//   1. Compose phase — the agent is told to author the task-specific prompt
//      and exit without acting on the task. Failure here propagates as a
//      normal agent failure.
//   2. Review gate — we read a yes/no answer from the user. The user may
//      edit the composed prompt file on disk before answering; the execute
//      phase will read whatever is there at gate-close time. "No" returns
//      a `blocked` result so runLoop halts cleanly and `resume` will retry
//      the task from the compose phase.
//   3. Execute phase — the agent is told to read the (possibly edited)
//      composed prompt and run the task per its contents, without
//      re-composing. The execute result is what we return to the caller.
//=====================
async function runAgentWithHumanInTheLoop(task, instructions, promptPath, composedPromptPath, resultSpec, resultFilePath) {
    const composedRel = path.relative(ROOT, composedPromptPath) || composedPromptPath;
    const { cmd: resolvedAgentCmd, source: resolvedAgentSource } = resolveAgentCmd(task);

    //=====================
    // Compose phase
    // No resultSpec enforcement here — the compose phase exists to author the
    // task prompt and exit. The agent does not execute the task, so it has
    // nothing to report yet. We deliberately pass null for both resultSpec
    // and resultFilePath so the prompt has no "Result reporting" section and
    // the WORKFLOW_RESULT_FILE env var is not set.
    //=====================
    const composeBody = renderPrompt(task, instructions, composedPromptPath, 'compose');
    fs.writeFileSync(promptPath, composeBody);
    emitTrace('[running] runAgent compose phase', {
        inputs: {
            taskKey: task.key,
            taskType: task.type,
            phase: 'compose',
            command: resolvedAgentCmd,
            commandSource: resolvedAgentSource,
            prompt_generated_path: path.relative(ROOT, promptPath),
            prompt_generated: composeBody,
            WORKFLOW_PROMPT_FILE: promptPath,
            WORKFLOW_PROMPT: readSafe(promptPath),
        },
    });
    log(`  -> human-in-the-loop: phase 1 of 2 (compose) for ${task.key}`);
    const composeResult = await _runAgentInner(task, { promptPath, composedPromptPath, promptBody: composeBody, resultSpec: null, resultFilePath: null });
    emitTrace('[finished] runAgent compose phase', {
        result: {
            ok: !!composeResult.ok,
            blocked: !!composeResult.blocked,
            hasError: !!composeResult.error,
            error: composeResult.error ? String(composeResult.error).split('\n')[0] : null,
        },
    });
    if (composeResult.blocked || !composeResult.ok) return composeResult;

    if (!fs.existsSync(composedPromptPath)) {
        return {
            ok: false,
            error: `compose phase finished but composed prompt was not created at ${composedRel}`,
            errorDetails: makeErrorDetails(task, {
                summary: `compose phase produced no composed prompt for ${task.key}`,
                reason: `agent exited cleanly but did not write ${composedRel}`,
                operation: 'human-in-the-loop compose phase',
                command: resolvedAgentCmd,
                artifacts_checked: [composedRel],
                suggested_fix:
                    'The compose phase agent finished without saving the composed prompt. ' +
                    'Inspect the most recent agent log under .workflow/ — likely causes: the agent ignored the Write step, ' +
                    'or wrote to a different path. Fix the prompt/agent and `resume`.',
            }),
        };
    }

    //=====================
    // Review gate
    //=====================
    log('');
    log(`  -> composed prompt ready for review: ${composedRel}`);
    log(`     You may open and edit that file before answering. The execute phase reads whatever is on disk after you answer.`);
    emitTrace('[running] runAgent review gate', { inputs: { taskKey: task.key, composedPromptPath: composedRel } });
    const proceed = await promptUserConfirmation(
        `Review the composed prompt and tell me: it's ok to proceed? You can change it if you want (y/n): `
    );
    emitTrace('[finished] runAgent review gate', { result: { taskKey: task.key, proceed } });
    if (!proceed) {
        const message =
            `User declined to proceed at human-in-the-loop compose review for "${task.key}".\n` +
            `The composed prompt is at ${composedRel} — review/edit it, then \`resume\` to retry the task.`;
        log('  -> step stopped at compose review.');
        return { blocked: true, message };
    }

    //=====================
    // Execute phase
    // Here we DO pass resultSpec/resultFilePath through. The prompt picks up
    // the "Result reporting" section, the agent's env gets WORKFLOW_RESULT_FILE,
    // and _runAgentInner validates the JSON handoff before reporting success.
    //=====================
    const executeBody = renderPrompt(task, instructions, composedPromptPath, 'execute', resultSpec, resultFilePath);
    fs.writeFileSync(promptPath, executeBody);
    emitTrace('[running] runAgent execute phase', {
        inputs: {
            taskKey: task.key,
            taskType: task.type,
            phase: 'execute',
            command: resolvedAgentCmd,
            commandSource: resolvedAgentSource,
            prompt_generated_path: path.relative(ROOT, promptPath),
            prompt_generated: executeBody,
            composed_prompt: readSafe(composedPromptPath),
            WORKFLOW_PROMPT_FILE: promptPath,
            WORKFLOW_COMPOSED_PROMPT_FILE: composedPromptPath,
            WORKFLOW_RESULT_FILE: resultFilePath,
            resultSpec: resultSpec || null,
        },
    });
    log(`  -> human-in-the-loop: phase 2 of 2 (execute) for ${task.key}`);
    const executeResult = await _runAgentInner(task, { promptPath, composedPromptPath, promptBody: executeBody, resultSpec, resultFilePath });
    emitTrace('[finished] runAgent execute phase', {
        result: {
            ok: !!executeResult.ok,
            blocked: !!executeResult.blocked,
            hasError: !!executeResult.error,
            error: executeResult.error ? String(executeResult.error).split('\n')[0] : null,
            detection: executeResult.detection || null,
            killReason: executeResult.killReason || null,
            agentResult: executeResult.agentResult || null,
        },
    });
    return executeResult;
}

//=====================
// _runAgentInner
// Spawns the agent in its own process group, streams output live to the
// user's terminal, tees raw bytes to a per-task log file, and watches stdout
// for Claude Code's stream-json `{"type":"result"}` event. When that event
// arrives we SIGTERM the process group (SIGKILL fallback after AGENT_KILL_GRACE_MS)
// so the workflow can move on even if the agent itself never exits — the
// previous hang was caused by claude / MCP children staying attached to stdio
// long after the conversation actually ended.
//
// Detection fallbacks:
//   - Agent emits non-JSON output → no detection fires, we honor the child's
//     natural exit code (preserves behavior for any non-Claude-Code agent).
//   - Agent hangs silently → optional idle-timeout watchdog
//     (state.config.agentIdleTimeoutMs, off by default) kills it after that
//     many milliseconds of zero bytes.
//   - User Ctrl-Cs the runner → SIGINT/SIGTERM/SIGHUP listeners forward the
//     signal to the agent group so no orphans are left behind.
//=====================
function _runAgentInner(task, prepared) {
    //=====================
    // Prompt files are prepared by the caller (runAgent) so they can be
    // included in the [running] trace event. We destructure them here and
    // derive `safe` from task.key for the per-task log filename below.
    // resultSpec / resultFilePath are also threaded through prepared: when
    // both are provided we expose WORKFLOW_RESULT_FILE to the agent and
    // validate the JSON handoff after the agent finishes.
    //=====================
    const { promptPath, composedPromptPath, promptBody, resultSpec, resultFilePath } = prepared;
    const safe = task.key.replace(/[^\w.\-]/g, '_');

    const { cmd, source: agentSource } = resolveAgentCmd(task);
    if (!cmd) {
        return Promise.resolve({
            blocked: true,
            message:
                `No agent configured for step "${task.key}".\n` +
                `Complete it manually (or set --agent / AGENT_CMD / \`set-step-agent ${task.key} "<cmd>"\`), then run \`resume\`.\n` +
                `Prompt written to: ${path.relative(ROOT, promptPath)}\n` +
                `If you compose your own task-specific prompt, save it to: ${path.relative(ROOT, composedPromptPath)}`,
        });
    }
    const agentEnv = {
        WORKFLOW_PROMPT_FILE: promptPath,
        WORKFLOW_TASK: task.key,
        WORKFLOW_COMPOSED_PROMPT_FILE: composedPromptPath,
    };
    if (resultSpec && resultFilePath) {
        agentEnv.WORKFLOW_RESULT_FILE = resultFilePath;
    }
    const logFile = path.join(WF_DIR, `agent_${safe}.log`);
    try { fs.unlinkSync(logFile); } catch { /* fresh log per invocation */ }
    const idleMs = state.config.agentIdleTimeoutMs || 0;
    log(`  -> invoking agent for ${task.key}`);
    log(`  -> agent command: ${cmd}${agentSource === 'step-override' ? ' (step override)' : ''}`);
    log(`  -> env vars passed to agent:`);
    for (const [k, v] of Object.entries(agentEnv)) log(`       ${k}=${v}`);
    log(`  -> prompt file:           ${path.relative(ROOT, promptPath)}`);
    log(`  -> composed prompt target: ${path.relative(ROOT, composedPromptPath)}`);
    if (resultSpec && resultFilePath) {
        log(`  -> required result file:  ${path.relative(ROOT, resultFilePath)} (keys: ${(resultSpec.required || []).join(', ') || '(none)'})`);
    }
    log(`  -> agent log:             ${path.relative(ROOT, logFile)}`);
    log(`  -> watchdog: stream-json result detection + idle timeout ` +
        `${idleMs > 0 ? `${idleMs}ms` : 'OFF'}`);
    log(`---------- BEGIN PROMPT (${task.key}) ----------`);
    log(promptBody);
    log(`----------  END PROMPT  (${task.key}) ----------`);

    //=====================
    // validateResultFile — hard-fail JSON handoff check.
    // Run on every success path (stream-json result with is_error=false,
    // OR natural exit 0). When resultSpec is null this is a no-op pass-through,
    // so tasks that don't opt in to the JSON channel keep their old behavior.
    // Failures here are surfaced with explicit suggested_fix language so the
    // user can see immediately what the agent forgot to do.
    //=====================
    function validateResultFile() {
        if (!resultSpec || !resultFilePath) return { ok: true, agentResult: null };
        const resultRel = path.relative(ROOT, resultFilePath) || resultFilePath;
        if (!fs.existsSync(resultFilePath)) {
            return {
                ok: false,
                error: `agent for "${task.key}" did not write the required result file at ${resultRel}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `missing required JSON handoff for ${task.key}`,
                    reason: `expected file at ${resultRel} was not created by the agent`,
                    operation: 'validate WORKFLOW_RESULT_FILE produced by the agent',
                    command: cmd,
                    log_file: path.relative(ROOT, logFile),
                    log_tail: readTail(logFile, 40),
                    prompt_file: path.relative(ROOT, promptPath),
                    env: agentEnv,
                    artifacts_checked: [resultRel],
                    suggested_fix:
                        `The agent finished its turn but did not write the result JSON the workflow needs. ` +
                        `The prompt at ${path.relative(ROOT, promptPath)} contains a "Result reporting" section that lists the required keys (${(resultSpec.required || []).join(', ')}). ` +
                        `Common causes: (1) the agent ignored the section; (2) the agent wrote the JSON to the wrong path; (3) the composed prompt was edited in HITL mode and the section was removed. ` +
                        `Inspect the agent log, then either re-run with a clearer prompt or write ${resultRel} by hand and \`node worflow.js resume\`.`,
                }),
            };
        }
        const raw = readSafe(resultFilePath);
        let parsed;
        try { parsed = JSON.parse(raw); }
        catch (e) {
            return {
                ok: false,
                error: `agent for "${task.key}" wrote invalid JSON to ${resultRel}: ${e.message}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `invalid JSON in agent result file for ${task.key}`,
                    reason: e.message,
                    operation: 'parse WORKFLOW_RESULT_FILE produced by the agent',
                    command: cmd,
                    log_file: path.relative(ROOT, logFile),
                    prompt_file: path.relative(ROOT, promptPath),
                    artifacts_checked: [resultRel],
                    log_tail: readTail(resultFilePath, 40),
                    suggested_fix:
                        `${resultRel} exists but is not valid JSON. Open it, fix the syntax, then \`node worflow.js resume\`. ` +
                        `If the file looks corrupted, delete it — the workflow will re-run the agent.`,
                }),
            };
        }
        if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {
                ok: false,
                error: `agent for "${task.key}" wrote a non-object JSON value to ${resultRel} (expected a JSON object)`,
                errorDetails: makeErrorDetails(task, {
                    summary: `wrong JSON shape in agent result file for ${task.key}`,
                    reason: `expected a JSON object, got ${Array.isArray(parsed) ? 'array' : typeof parsed}`,
                    operation: 'shape-check WORKFLOW_RESULT_FILE produced by the agent',
                    command: cmd,
                    log_file: path.relative(ROOT, logFile),
                    prompt_file: path.relative(ROOT, promptPath),
                    artifacts_checked: [resultRel],
                    suggested_fix: `Rewrite ${resultRel} as a JSON object with the required keys: ${(resultSpec.required || []).join(', ')}. Then \`node worflow.js resume\`.`,
                }),
            };
        }
        const required = Array.isArray(resultSpec.required) ? resultSpec.required : [];
        const missing = required.filter((k) =>
            !Object.prototype.hasOwnProperty.call(parsed, k) ||
            parsed[k] == null ||
            (typeof parsed[k] === 'string' && parsed[k].trim() === ''));
        if (missing.length) {
            return {
                ok: false,
                error: `agent for "${task.key}" result file ${resultRel} is missing required key(s): ${missing.join(', ')}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `incomplete agent result file for ${task.key}`,
                    reason: `missing or empty required key(s): ${missing.join(', ')}`,
                    operation: 'validate required keys in WORKFLOW_RESULT_FILE',
                    command: cmd,
                    log_file: path.relative(ROOT, logFile),
                    prompt_file: path.relative(ROOT, promptPath),
                    artifacts_checked: [resultRel],
                    suggested_fix:
                        `Add the missing key(s) (${missing.join(', ')}) to ${resultRel} with a non-empty value, then \`node worflow.js resume\`. ` +
                        `The prompt's "Result reporting" section describes what each key should contain.`,
                }),
            };
        }
        return { ok: true, agentResult: parsed };
    }

    return new Promise((resolve) => {
        //=====================
        // Spawn the agent in a NEW process group
        // detached:true makes PGID === child.pid so `kill -- -pid` reaches
        // every descendant (claude + any tee in call_agent.sh + MCP children).
        // We pipe stdout/stderr instead of inherit so we can both forward
        // bytes live AND parse them for the stream-json result event.
        //=====================
        let child;
        try {
            child = spawn('/bin/bash', ['-c', cmd], {
                stdio: ['ignore', 'pipe', 'pipe'],
                detached: true,
                cwd: ROOT,
                env: { ...process.env, ...agentEnv },
            });
        } catch (e) {
            resolve({
                ok: false,
                error: `agent spawn error: ${e.message}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `failed to spawn the configured agent for ${task.key}`,
                    reason: e.message,
                    operation: 'spawn agent subprocess',
                    command: cmd,
                    prompt_file: path.relative(ROOT, promptPath),
                    env: agentEnv,
                    stack_trace: e.stack,
                    suggested_fix:
                        'The shell itself could not start the agent. Check that /bin/bash exists and that the agent command is valid shell. ' +
                        'Try running the command manually in this shell to see what fails first. After fixing, `node worflow.js resume`.',
                }),
            });
            return;
        }

        const logStream = fs.createWriteStream(logFile, { flags: 'w' });
        const decoder = new StringDecoder('utf8');
        let lineBuf = '';
        let detectedDone = false;
        let detectionResult = null;
        let killReason = null;
        let killSent = false;
        let idleTimer = null;
        let settled = false;

        //=====================
        // killAgent — idempotent teardown of the agent's process group.
        // Both the stream-json detection path and the signal-forwarding path
        // call this; the first caller wins, subsequent calls are no-ops.
        // SIGKILL fallback fires after AGENT_KILL_GRACE_MS so MCP servers
        // that ignore SIGTERM cannot hang the workflow indefinitely.
        //=====================
        function killAgent(reason) {
            if (killSent) return;
            killSent = true;
            killReason = reason;
            try { process.kill(-child.pid, 'SIGTERM'); } catch { /* group already gone */ }
            setTimeout(() => {
                try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
            }, AGENT_KILL_GRACE_MS).unref();
        }

        //=====================
        // Idle watchdog
        // Reset on every byte from stdout or stderr. Disabled when idleMs is 0
        // so agents with long legitimate silent stretches are unaffected by
        // default; users opt in with --agent-idle-timeout.
        //=====================
        function armIdleTimer() {
            if (!idleMs) return;
            if (idleTimer) clearTimeout(idleTimer);
            idleTimer = setTimeout(() => { killAgent('idle_timeout'); }, idleMs);
        }
        armIdleTimer();

        //=====================
        // Stream-json line parser
        // Claude Code with --output-format stream-json emits one JSON object
        // per line on stdout, with a final {"type":"result", ...} event when
        // the conversation truly ends. We only act on that event; any line
        // that does not parse, or whose type is not "result", is ignored.
        // This means agents that don't emit stream-json simply never trigger
        // detection and fall back to their natural exit code.
        //=====================
        function checkLine(line) {
            const trimmed = line.trim();
            if (!trimmed || trimmed[0] !== '{') return;
            let obj;
            try { obj = JSON.parse(trimmed); } catch { return; }
            if (!obj || obj.type !== 'result') return;
            detectedDone = true;
            detectionResult = {
                subtype: obj.subtype != null ? obj.subtype : null,
                is_error: obj.is_error === true,
                duration_ms: obj.duration_ms != null ? obj.duration_ms : null,
                num_turns: obj.num_turns != null ? obj.num_turns : null,
                total_cost_usd: obj.total_cost_usd != null ? obj.total_cost_usd : null,
                session_id: obj.session_id != null ? obj.session_id : null,
            };
            log(`  -> stream-json result detected (subtype=${detectionResult.subtype}, is_error=${detectionResult.is_error}) — tearing down agent`);
            killAgent('stream_json_result');
        }

        child.stdout.on('data', (chunk) => {
            armIdleTimer();
            process.stdout.write(chunk);
            logStream.write(chunk);
            if (detectedDone) return;
            //=====================
            // StringDecoder handles multi-byte UTF-8 chars that straddle
            // chunk boundaries — without it a 3-byte CJK char split across
            // two data events would produce a replacement char inside the
            // line buffer and could break JSON parsing on that line.
            //=====================
            lineBuf += decoder.write(chunk);
            let nl;
            while ((nl = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, nl);
                lineBuf = lineBuf.slice(nl + 1);
                checkLine(line);
                if (detectedDone) break;
            }
        });

        child.stderr.on('data', (chunk) => {
            armIdleTimer();
            process.stderr.write(chunk);
            logStream.write(chunk);
        });

        //=====================
        // Signal forwarding
        // The agent lives in its own process group, so terminal signals
        // (Ctrl-C) do not reach it automatically. Without this, a Ctrl-C of
        // caal.jswould orphan claude. The existing onSigint handler in
        // execute() runs in parallel and sets the cooperative STOP flag.
        // Listeners are removed in cleanup() so they do not accumulate
        // across successive agent invocations.
        //=====================
        const onSignal = () => killAgent('signal');
        process.on('SIGINT', onSignal);
        process.on('SIGTERM', onSignal);
        process.on('SIGHUP', onSignal);

        function cleanup() {
            if (idleTimer) clearTimeout(idleTimer);
            process.removeListener('SIGINT', onSignal);
            process.removeListener('SIGTERM', onSignal);
            process.removeListener('SIGHUP', onSignal);
            try { logStream.end(); } catch { /* ignore */ }
        }

        child.on('error', (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve({
                ok: false,
                error: `agent spawn error: ${err.message}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `failed to spawn the configured agent for ${task.key}`,
                    reason: err.message,
                    operation: 'spawn agent subprocess',
                    command: cmd,
                    prompt_file: path.relative(ROOT, promptPath),
                    env: agentEnv,
                    stack_trace: err.stack,
                    suggested_fix:
                        'The shell itself could not start the agent. Check that /bin/bash exists and that the agent command is valid shell. ' +
                        'Try running the command manually in this shell to see what fails first. After fixing, `node worflow.js resume`.',
                }),
            });
        });

        child.on('close', (code, signal) => {
            if (settled) return;
            settled = true;
            //=====================
            // Drain the line buffer
            // The agent may have emitted a result event without a trailing
            // newline before exiting. Without this drain a clean run could
            // look like "agent just exited" rather than a detected completion.
            //=====================
            lineBuf += decoder.end();
            if (!detectedDone && lineBuf.length > 0) {
                for (const line of lineBuf.split('\n')) {
                    checkLine(line);
                    if (detectedDone) break;
                }
            }
            cleanup();

            //=====================
            // Outcome decision
            // Priority: a detected `result` event always wins over the child's
            // own exit code (we killed it on purpose, so its signal/code is
            // incidental). is_error: true from the stream-json result is a
            // soft failure — agent ran but reported its own error condition.
            //=====================
            if (detectedDone) {
                if (detectionResult && detectionResult.is_error) {
                    const tail = readTail(logFile, 40);
                    resolve({
                        ok: false,
                        error: `agent for "${task.key}" reported is_error via stream-json result (subtype=${detectionResult.subtype})`,
                        detection: detectionResult,
                        killReason,
                        errorDetails: makeErrorDetails(task, {
                            summary: `agent for "${task.key}" reported a stream-json error result`,
                            reason: `subtype=${detectionResult.subtype}, is_error=true after ${detectionResult.num_turns} turn(s)`,
                            operation: 'run configured agent subprocess (stream-json)',
                            command: cmd,
                            log_file: path.relative(ROOT, logFile),
                            log_tail: tail,
                            prompt_file: path.relative(ROOT, promptPath),
                            env: agentEnv,
                            detection: detectionResult,
                            suggested_fix:
                                'Claude Code finished its turn-loop but flagged the result as an error (often: tool failure, max turns hit, or content policy). ' +
                                'Read the agent log tail above for the specific reason, then `node worflow.js resume`.',
                        }),
                    });
                    return;
                }
                if (fs.existsSync(composedPromptPath)) {
                    log(`  -> composed prompt saved: ${path.relative(ROOT, composedPromptPath)}`);
                } else {
                    logYellow(`  -> warning: agent did not save its composed prompt to ${path.relative(ROOT, composedPromptPath)}`);
                }
                //=====================
                // Validate the JSON handoff before reporting success.
                // No-op when resultSpec was not requested. Hard failure when
                // the file is missing, malformed, or incomplete — the
                // workflow needs the structured handoff to proceed and
                // recovering from an absent file requires human input.
                //=====================
                const validation = validateResultFile();
                if (!validation.ok) {
                    resolve({ ...validation, detection: detectionResult, killReason });
                    return;
                }
                resolve({ ok: true, detection: detectionResult, killReason, agentResult: validation.agentResult });
                return;
            }

            //=====================
            // Idle-timeout failure path
            // Distinct from a generic exit-code failure because the agent
            // never said anything — the user needs to investigate whether
            // the agent hung (network, MCP) or whether the watchdog is just
            // too tight for the workload.
            //=====================
            if (killReason === 'idle_timeout') {
                const tail = readTail(logFile, 40);
                resolve({
                    ok: false,
                    error: `agent for "${task.key}" produced no output for ${idleMs}ms — killed by idle watchdog`,
                    killReason,
                    errorDetails: makeErrorDetails(task, {
                        summary: `agent for "${task.key}" hung silently (idle ${idleMs}ms)`,
                        reason: 'no bytes on stdout or stderr for the idle-timeout window',
                        operation: 'run configured agent subprocess (idle watchdog tripped)',
                        command: cmd,
                        log_file: path.relative(ROOT, logFile),
                        log_tail: tail || '(no output produced)',
                        prompt_file: path.relative(ROOT, promptPath),
                        env: agentEnv,
                        idle_ms: idleMs,
                        suggested_fix:
                            'The agent stayed silent past the idle watchdog. Common causes: blocked on a network call, an MCP server hung at startup, or the workload genuinely needs more silent time. ' +
                            'Either raise --agent-idle-timeout (or WORKFLOW_AGENT_IDLE_TIMEOUT_SEC), or investigate why the agent is not making progress. After fixing, `node worflow.js resume`.',
                    }),
                });
                return;
            }

            //=====================
            // Natural-exit path
            // The agent exited on its own (or via a forwarded user signal)
            // without ever emitting a stream-json result. Preserve the old
            // behavior: exit 0 → success, anything else → failure with
            // detailed diagnostics.
            //=====================
            const exitCode = signal ? (SIGNAL_TO_EXIT[signal] || 128) : (code != null ? code : 1);
            if (exitCode === 0 && !signal) {
                if (fs.existsSync(composedPromptPath)) {
                    log(`  -> composed prompt saved: ${path.relative(ROOT, composedPromptPath)}`);
                } else {
                    logYellow(`  -> warning: agent did not save its composed prompt to ${path.relative(ROOT, composedPromptPath)}`);
                }
                //=====================
                // Validate the JSON handoff before reporting success.
                // Same hard-fail policy as the stream-json detection path.
                //=====================
                const validation = validateResultFile();
                if (!validation.ok) {
                    resolve({ ...validation, killReason });
                    return;
                }
                resolve({ ok: true, killReason, agentResult: validation.agentResult });
                return;
            }
            const reason = describeExitStatus(code, signal);
            const codePart = code === null ? `signal ${signal || 'unknown'}` : `exit code ${code}`;
            const tail = readTail(logFile, 40);
            const parts = [
                `agent for "${task.key}" failed — ${codePart} (${reason})`,
                `command: ${cmd}`,
                `log:     ${path.relative(ROOT, logFile)}`,
            ];
            if (tail) {
                parts.push('--- tail of agent output ---');
                parts.push(tail);
                parts.push('--- end of agent output ---');
            } else {
                parts.push('(agent produced no output — check that the command exists and is executable)');
            }
            resolve({
                ok: false,
                error: parts.join('\n'),
                killReason,
                errorDetails: makeErrorDetails(task, {
                    summary: `agent for "${task.key}" failed (${codePart})`,
                    reason,
                    operation: 'run configured agent subprocess',
                    command: cmd,
                    exit_code: code,
                    signal,
                    exit_reason: reason,
                    log_file: path.relative(ROOT, logFile),
                    log_tail: tail || '(no output produced — check that the command exists and is executable)',
                    prompt_file: path.relative(ROOT, promptPath),
                    env: agentEnv,
                    suggested_fix: suggestFixForAgent(code, signal, tail),
                }),
            });
        });
    });
}

/* ----------------------------- shell actions ------------------------------ */

function sh(command) {
    emitTrace('[running] sh', { inputs: { command } });
    const r = spawnSync(command, { shell: true, stdio: 'inherit', cwd: ROOT });
    const status = r.error ? -1 : r.status;
    emitTrace('[finished] sh', { result: { command, status, spawnError: r.error ? String(r.error.message) : null } });
    return status;
}

function cmdDone(key) {
    emitTrace('[running] cmdDone', { inputs: { key } });
    if (!loadState()) die('no workflow initialized.');
    const task = state.tasks.find((t) => t.key === key);
    if (!task) die(`task not found: ${key}. Run "status" to see task keys.`);
    if (task.status === 'done') {
        console.log(`already done: ${key}`);
        emitTrace('[finished] cmdDone', { result: { key, noop: true } });
        return;
    }
    task.status = 'done';
    task.finishedAt = now();
    task.error = null;
    task.error_details = null;
    persist();
    console.log(`marked done: ${key}`);
    emitTrace('[finished] cmdDone', { result: { key, markedDone: true } });
}

function restartServer(task) {
    emitTrace('[running] restartServer', { inputs: { taskKey: task ? task.key : null, warmupMs: state.config.warmupMs } });
    const result = _restartServerInner(task);
    emitTrace('[finished] restartServer', { result: { ok: !!result.ok, hasError: !!result.error } });
    return result;
}

function _restartServerInner(task) {
    log('  -> stopping dev server (npm run delete:dev)');
    sh('npm run delete:dev'); // ignore failures (may not be running)
    log('  -> starting dev server (npm run start:dev)');
    try {
        const c = spawn('npm run start:dev', { shell: true, detached: true, stdio: 'ignore', cwd: ROOT });
        c.unref();
    } catch (e) {
        return {
            ok: false,
            error: 'failed to start dev server: ' + e.message,
            errorDetails: makeErrorDetails(task || { key: 'restartServer', type: 'RUN_TEST', kind: 'deterministic', attempts: 0, maxAttempts: 0 }, {
                summary: 'failed to start dev server',
                reason: e.message,
                operation: 'spawn detached `npm run start:dev`',
                command: 'npm run start:dev',
                stack_trace: e.stack,
                suggested_fix:
                    'Verify that the `start:dev` npm script exists in package.json and that `node_modules/` is populated (run `npm install`). ' +
                    'If a previous instance is still bound to the dev port, run `npm run delete:dev` manually and confirm the port is free with `lsof -i :<port>`. ' +
                    'After fixing, `node worflow.js resume`.',
            }),
        };
    }
    sleepSync(1000 * 20);
    return { ok: true };
}

// Run the BDD suite for the given cucumber tag expression, capturing combined
// stdout+stderr to a log file so we can surface the actual failure reason on
// error instead of just an exit code. Callers that omit `tagExpr` fall back to
// the story-level tag (used by RUN_FULL_SUITE); per-scenario callers pass a
// scenario-specific expression like `@US030-scenario-1`.
function runTaggedTests(tagExpr) {
    if (tagExpr === undefined || tagExpr === null) tagExpr = state.story.tag;
    emitTrace('[running] runTaggedTests', { inputs: { tagExpr } });
    const result = _runTaggedTestsInner(tagExpr);
    emitTrace('[finished] runTaggedTests', {
        result: {
            ok: result.ok,
            status: result.status,
            signal: result.signal,
            command: result.command,
            spawnError: result.spawnError,
            tagExpr: result.tagExpr,
            zeroScenarios: result.zeroScenarios,
        },
    });
    return result;
}

function _runTaggedTestsInner(tagExpr) {
    // Single-quote the tag expression so shell metacharacters ("or", parens,
    // spaces in compound expressions) are protected. Tags never contain a
    // single quote, so simple wrapping is safe.
    const command = `npm run test:tag '${tagExpr}'`;
    const safeTag = tagExpr.replace(/[^\w]/g, '_');
    const logFile = path.join(WF_DIR, `tests_${safeTag}.log`);
    try { fs.unlinkSync(logFile); } catch { /* fresh log per run */ }
    log(`  -> ${command}`);
    log(`  -> test log: ${path.relative(ROOT, logFile)}`);
    const wrapped = `set -o pipefail; ( ${command} ) 2>&1 | tee ${JSON.stringify(logFile)}`;
    const r = spawnSync(wrapped, { shell: '/bin/bash', stdio: 'inherit', cwd: ROOT });
    // Cucumber exits 0 even when the tag expression matches zero scenarios.
    // Detect the "0 scenarios" summary line and treat it as a failure so
    // silent skips (e.g., tag/convention drift between workflow and feature
    // file) can no longer masquerade as passing tests.
    const zeroScenarios = /^0 scenarios/m.test(stripAnsi(readSafe(logFile) || ''));
    const spawnOk = !r.error && r.status === 0;
    return {
        ok: spawnOk && !zeroScenarios,
        status: r.status,
        signal: r.signal,
        spawnError: r.error ? String(r.error.message) : null,
        command,
        logFile,
        logTail: readTail(logFile, 60),
        tagExpr,
        zeroScenarios,
    };
}

/* ------------------------------- handlers --------------------------------- */

async function handle(task) {
    emitTrace(`[running] handle ${task.type}`, { inputs: { taskKey: task.key, taskType: task.type, taskMeta: task.meta, attempt: task.attempts } });
    const result = await _handleInner(task);
    emitTrace(`[finished] handle ${task.type}`, { result });
    return result;
}

async function _handleInner(task) {
    emitTrace(`[info] handling task ${task.type}`, { task });

    switch (task.type) {

        case 'COMPLETE_DEV_PARTS': {
            //=====================
            // Delegate to the agent to fill the "(the part below should be
            // compiled by devs)" block of the spec file scaffolded by `start`.
            // The prompt mirrors the wording requested by the user so the
            // composed-prompt step can match without surprise. Sections that
            // must be filled in are listed explicitly so the agent does not
            // miss any; the prompt also forbids editing anything above the
            // marker so the original user-story content stays intact.
            //=====================
            const specRel = state.story.sourceFile;
            return runAgent(task,
                `complete the parts under (the part below should be compiled by devs) in @${specRel}\n\n` +
                `Required outputs in that file (under the marker only — do NOT modify content above the marker):\n` +
                `- non_functional_specifications\n` +
                `- api_endpoints (paths, request/response payloads, error codes)\n` +
                `- implementation_details_backend\n` +
                `- implementation_details_frontend\n` +
                `- user flow backend http calls\n` +
                `- data_model\n` +
                `- (optional) user flow ajax http calls\n\n` +
                `Base every choice on the user-story content (requirements, acceptance criteria, constraints, ` +
                `suggestions for devs, user_flow_frontend) that lives above the marker in the same file, plus ` +
                `the project conventions in AGENTS.md and docs/architecture/.`);
        }

        case 'MARK_STORY_IN_PROGRESS': {
            setStoryFlag(state.story.id, 'in_progress', 'true');
            state.story.status = 'in_progress';
            return { ok: true };
        }

        case 'DECOMPOSE_FEATURES': {
            ensureDir(storyDir());
            if (!fs.existsSync(sharedFile())) {
                fs.writeFileSync(sharedFile(),
                    `# Shared across features — ${state.story.id}\n\n` +
                    `Rules and knowledge shared by all features of this user story.\n`);
            }
            const res = await runAgent(task,
                `Decompose ${state.story.id} into implementation features. Split into more than one ` +
                `feature only if the story is big. For each feature create ${path.relative(ROOT, storyDir())}/feature_N.md ` +
                `following the feature_template. Put shared rules in shared_across_features.md (already scaffolded).`);
            if (res.blocked || !res.ok) return res;
            const features = discoverFeatures();
            if (features.length === 0) {
                const dir = storyDir();
                const safeKey = task.key.replace(/[^\w.\-]/g, '_');
                return {
                    ok: false,
                    error: 'no feature_*.md files were produced',
                    errorDetails: makeErrorDetails(task, {
                        summary: 'agent finished cleanly but produced no feature_*.md files',
                        reason: `expected at least one file matching feature_*.md inside ${path.relative(ROOT, dir)}`,
                        operation: 'discover features after decompose agent run',
                        artifacts_checked: [path.relative(ROOT, dir)],
                        files_found: fs.existsSync(dir) ? fs.readdirSync(dir) : [],
                        prompt_file: path.relative(ROOT, path.join(PROMPTS_DIR, `${safeKey}.md`)),
                        log_file: path.relative(ROOT, path.join(WF_DIR, `agent_${safeKey}.log`)),
                        suggested_fix:
                            `The decompose agent exited 0 but did not write any feature_N.md files in ${path.relative(ROOT, dir)}. ` +
                            `Read the agent log (.workflow/agent_${safeKey}.log) to see what it actually did — common causes: it wrote to the wrong directory, ` +
                            `or it produced commentary without committing files. Either (a) re-run the agent with a sharper prompt, or ` +
                            `(b) create feature_1.md manually following the feature_template, then \`node worflow.js resume\`.`,
                    }),
                };
            }
            progress(`Decomposed ${state.story.id} into ${features.length} feature(s)`);
            return { ok: true };
        }

        case 'EXPAND_FEATURE_GROUPS': {
            const features = discoverFeatures();
            if (features.length === 0) {
                const dir = storyDir();
                return {
                    ok: false,
                    error: 'no feature_*.md files found — has story.decompose run?',
                    errorDetails: makeErrorDetails(task, {
                        summary: 'cannot expand BDD task tree — no features on disk',
                        reason: `no feature_*.md files in ${path.relative(ROOT, dir)}`,
                        operation: 'expand feature groups in the task tree',
                        artifacts_checked: [path.relative(ROOT, dir)],
                        files_found: fs.existsSync(dir) ? fs.readdirSync(dir) : [],
                        suggested_fix:
                            `Run \`node worflow.js status\` — the prior step (story.decompose) should have produced feature_N.md files but did not. ` +
                            `Re-run decompose (mark it pending in .workflow/state.json then resume), or create the feature files manually following the feature_template.`,
                    }),
                };
            }
            const expand = [];
            for (const n of features) expand.push(...featureGroup(n));
            progress(`Expanded BDD tasks for ${features.length} feature(s)`);
            return { ok: true, expand };
        }

        case 'CREATE_GHERKIN': {
            //=====================
            // The agent uses the bdd-gherkin-feature-writer skill to choose
            // where to write the .feature file. That skill organizes tests by
            // business domain (e.g. `tests/features/<domain>/<capability>.feature`)
            // so we cannot derive the path from the story number alone. We
            // require the agent to report the path it used via a structured
            // JSON handoff (WORKFLOW_RESULT_FILE), then verify on disk and
            // discover scenarios from there.
            //=====================
            const n = task.meta.featureNum;
            ensureDir(path.join(ROOT, 'tests', 'features'));

            emitTrace(`[info] create gherkin info`, { featureNum: n });

            const res = await runAgent(task,
                [
                    `Create a Gherkin \`.feature\` file inside \`tests/features\` ` +
                    `- create max ${MAX_SCENARIOS} scenarios`,
                    `- use the skill bdd-gherkin-feature-writer to know where to save the .feature file`,
                    `- use the skill bdd-gherkin-feature-writer to know how to write steps`,
                    `- use the skill bdd-gherkin-feature-writer to know how to write tags`,
                    `- You must write steps to assert database values changes`,
                    `- You must insert steps to verify values in audit table`,
                ].join('\n'),
                {
                    required: ['gherkin_path'],
                    schema: {
                        gherkin_path: 'string — path (relative to the project root) of the .feature file you created or modified during this task. Example: "tests/features/<domain>/<capability>.feature".',
                    },
                });
            if (res.blocked || !res.ok) return res;

            //=====================
            // Trust-but-verify the agent's reported path. The JSON validation
            // in _runAgentInner already enforced that `gherkin_path` is
            // present and non-empty; here we resolve it against ROOT and
            // confirm the file actually exists on disk before reading it.
            //=====================
            const reportedPath = String(res.agentResult.gherkin_path);
            const gherkinAbs = path.resolve(ROOT, reportedPath);
            const gherkinRel = path.relative(ROOT, gherkinAbs);
            if (!fs.existsSync(gherkinAbs)) {
                return {
                    ok: false,
                    error: `agent reported gherkin_path "${reportedPath}" but the file does not exist on disk`,
                    errorDetails: makeErrorDetails(task, {
                        summary: `gherkin file reported by agent does not exist`,
                        reason: `${gherkinRel} was not found`,
                        operation: 'verify the gherkin path reported by the agent in its result JSON',
                        feature_number: n,
                        gherkin_file: gherkinRel,
                        artifacts_checked: [gherkinRel],
                        suggested_fix:
                            `The agent's result JSON claims it wrote ${gherkinRel}, but that file is not on disk. ` +
                            `Check the agent log under .workflow/agent_${task.key.replace(/[^\w.\-]/g, '_')}.log to see where the file actually went. ` +
                            `Then either fix the agent prompt or correct the path in .workflow/results/${task.key.replace(/[^\w.\-]/g, '_')}.json and \`resume\`.`,
                    }),
                };
            }

            const scenarios = discoverScenariosAt(gherkinAbs);

            emitTrace('[running] CREATE_GHERKIN scenario discovery', {
                inputs: {
                    featureNum: n,
                    gherkin_path: gherkinAbs,
                    reported_by_agent: reportedPath,
                    scenarios_count: scenarios.length,
                    scenarios,
                },
            });

            if (scenarios.length === 0) {
                return {
                    ok: false,
                    error: `no scenarios found in ${gherkinRel}`,
                    errorDetails: makeErrorDetails(task, {
                        summary: `gherkin file has no scenarios`,
                        reason: `${gherkinRel} exists but contains no \`Scenario:\` or \`Scenario Outline:\` lines`,
                        operation: `discover scenarios in feature ${n} gherkin`,
                        feature_number: n,
                        gherkin_file: gherkinRel,
                        gherkin_preview: readTail(gherkinAbs, 40) || '(file empty)',
                        suggested_fix:
                            `Open ${gherkinRel} and confirm it contains at least one \`Scenario:\` line tagged ${state.story.tag}. ` +
                            `The skill bdd-gherkin-feature-writer should produce well-formed gherkin — check its output in the agent log under .workflow/. ` +
                            `After fixing the file, \`node worflow.js resume\`.`,
                    }),
                };
            }

            //=====================
            // Persist the discovered path on this task's meta so downstream
            // tasks (IMPL_STEPDEFS, RUN_TEST) can look it up without
            // re-deriving. Multiple workflow-features may legitimately point
            // at the same .feature file when the skill maps them to one
            // domain capability — that's expected, not a bug.
            //=====================
            task.meta.gherkinPath = gherkinRel;

            const expand = [];
            scenarios.forEach((name, i) => expand.push(...scenarioGroup(n, i + 1, name)));
            progress(`Feature ${n}: created gherkin with ${scenarios.length} scenario(s) at ${gherkinRel}`);
            return { ok: true, expand };
        }

        case 'IMPL_CODE': {
            return runAgent(task,
                `Implement the production code required to satisfy scenario "${task.meta.scenarioName}" ` +
                `(feature ${task.meta.featureNum}). Follow AGENTS.md and the existing architecture/data model. ` +
                `\n\nSCOPE — this step is CODE GENERATION ONLY. Do NOT run any tests, do NOT reload or restart ` +
                `the dev server, and do NOT execute \`npm run test:tag\`, \`npm run reload:dev\`, or any other ` +
                `test/server command. Test execution is performed by a separate downstream step in this ` +
                `workflow; running tests here is out of scope and will duplicate work. When composing the ` +
                `task-specific prompt, ignore any sub-steps from the base prompt that describe running tests, ` +
                `reloading the server, or debugging test failures — those belong to later steps.`);
        }

        case 'IMPL_STEPDEFS': {
            return runAgent(task,
                `Implement the step definitions for scenario "${task.meta.scenarioName}" (feature ${task.meta.featureNum}). ` +
                `Make them robust and maintainable. Do not bypass real application logic. Use bdd-gherkin-feature-writer.`);
        }

        case 'RUN_TEST': {
            const restart = restartServer(task);
            if (!restart.ok) return restart;
            // Per-scenario tag convention set by the bdd-gherkin-feature-writer
            // skill: @USXXX-scenario-y. Using the bare story tag here would
            // match zero scenarios and cucumber would exit 0, so the workflow
            // would silently skip the test.
            const scenarioTag = `${state.story.tag}-scenario-${task.meta.scenarioNum}`;
            const t = runTaggedTests(scenarioTag);
            if (t.ok) return { ok: true };
            const reason = t.spawnError
                ? `failed to spawn test runner: ${t.spawnError}`
                : t.zeroScenarios
                    ? `tag '${scenarioTag}' matched no scenarios (cucumber exited 0 with 0 scenarios) — check the .feature file uses the same tag as the workflow expects`
                    : describeExitStatus(t.status, t.signal);
            const suggested = t.zeroScenarios
                ? `The tag '${scenarioTag}' matched no scenarios in the .feature file. Confirm the scenario in the feature file is tagged with exactly '${scenarioTag}' (the bdd-gherkin-feature-writer skill convention is @USXXX-scenario-y). Fix the tag in the .feature file or the workflow, then \`resume\`.`
                : suggestFixForTestFailure(t.logTail);
            return {
                ok: false,
                error: `tests tagged ${scenarioTag} failed — ${reason}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `BDD scenario test for "${task.meta.scenarioName}" (feature ${task.meta.featureNum}) failed`,
                    reason,
                    operation: 'run cucumber tagged tests for the scenario',
                    command: t.command,
                    exit_code: t.status,
                    signal: t.signal,
                    exit_reason: describeExitStatus(t.status, t.signal),
                    log_file: path.relative(ROOT, t.logFile),
                    log_tail: t.logTail,
                    story_tag: scenarioTag,
                    zero_scenarios: t.zeroScenarios || undefined,
                    scenario: task.meta.scenarioName,
                    scenario_number: task.meta.scenarioNum,
                    feature_number: task.meta.featureNum,
                    retry: task.meta.retry || 0,
                    max_retries: state.config.maxRetries,
                    suggested_fix: suggested,
                }),
            };
        }

        case 'DEBUG': {
            //=====================
            // Build an agentic-debug prompt for the failing scenario, mirroring
            // what DEBUG_FULL_SUITE does. The log tail is threaded through the
            // task meta by handleFailure() when it splices this task; if it is
            // missing (e.g. state edited by hand), we fall back to reading the
            // per-scenario cucumber log from .workflow/.
            //=====================
            const retryNum = task.meta.retry || 1;
            const scenarioName = task.meta.scenarioName || '(unknown scenario)';
            const featureNum = task.meta.featureNum;
            const scenarioNum = task.meta.scenarioNum;
            const scenarioTag = `${state.story.tag}-scenario-${scenarioNum}`;
            const fallbackLog = path.join(WF_DIR, `tests__US${state.story.padded}_scenario_${scenarioNum}.log`);
            const logTail = task.meta.logTail || readTail(fallbackLog, 120) || '(no log tail available)';

            const debugContext = [
                `Story: ${state.story.id} (tag ${state.story.tag})`,
                `Feature: ${featureNum}`,
                `Failing scenario: "${scenarioName}" (tag ${scenarioTag})`,
                `Retry attempt: ${retryNum} of ${state.config.maxRetries}`,
                '',
                'Scenario test log tail:',
                logTail,
            ].join('\n');

            const debugResult = generateDebugPrompt(debugContext);
            if (!debugResult.ok) {
                log(`  -> warning: ${debugResult.error}. Proceeding with inline context only.`);
            }

            const agentInstructions = [
                `Scenario test for "${scenarioName}" (feature ${featureNum}) failed on retry #${retryNum}.`,
                debugResult.ok
                    ? `A debug prompt has been generated at @debug_prompt.txt — read it for context including request logs and tracing data.`
                    : `Debug context:\n${debugContext}`,
                '',
                `Diagnose per skill 'agentic-debug' and fix the implementation or step definitions.`,
                `Do not weaken or skip the test. After fixing, the workflow will re-run the scenario.`,
            ].filter(Boolean).join('\n');

            return runAgent(task, agentInstructions);
        }

        case 'UNIT_TESTS': {
            return runAgent(task,
                `Develop and run unit tests for the jobs and operations of feature ${task.meta.featureNum}. ` +
                `Diagnose and fix any failures per 'agentic-debug' until they pass.`);
        }

        case 'MARK_FEATURE_DONE': {
            const p = featureSpec(task.meta.featureNum);
            const txt = readSafe(p);
            if (txt !== null) {
                const updated = txt
                    .replace(/^(\s*done\s*:\s*).*$/mi, '$1true')
                    .replace(/^(\s*in_progress\s*:\s*).*$/mi, '$1false');
                fs.writeFileSync(p, updated);
            }
            progress(`Feature ${task.meta.featureNum}: marked done`);
            return { ok: true };
        }

        case 'RUN_FULL_SUITE': {
            const restart = restartServer(task);
            if (!restart.ok) return restart;
            const t = runTaggedTests();
            if (t.ok) return { ok: true };
            const reason = t.spawnError
                ? `failed to spawn test runner: ${t.spawnError}`
                : describeExitStatus(t.status, t.signal);

            //=====================
            // Parse failed scenario names from the full suite log
            // Used by the DEBUG_FULL_SUITE handler to pick one scenario to debug
            //=====================
            const failedScenarios = parseFailedScenarios(t.logTail);
            const fullLogText = readSafe(t.logFile) || t.logTail;
            const failedScenariosAll = parseFailedScenarios(fullLogText);

            return {
                ok: false,
                error: `full suite for ${state.story.id} (tag ${state.story.tag}) failed — ${reason}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `Full test suite for ${state.story.id} (tag ${state.story.tag}) failed`,
                    reason,
                    operation: 'run full BDD suite tagged for the story',
                    command: t.command,
                    exit_code: t.status,
                    signal: t.signal,
                    exit_reason: describeExitStatus(t.status, t.signal),
                    log_file: path.relative(ROOT, t.logFile),
                    log_tail: t.logTail,
                    story_tag: state.story.tag,
                    story_id: state.story.id,
                    failed_scenarios: failedScenariosAll,
                    retry: task.meta.retry || 0,
                    max_retries: state.config.maxRetries,
                    suggested_fix: suggestFixForTestFailure(t.logTail) +
                        '\n\nNote: this runs after each scenario already passed in isolation, so a failure here typically means scenarios interact (shared state, ordering, dirty database). Read the log to identify which scenario tag failed in the suite run, then fix the cross-scenario assumption.',
                }),
            };
        }

        case 'DEBUG_FULL_SUITE': {
            //=====================
            // Pick the first failed scenario from the parent RUN_FULL_SUITE error details
            // Falls back to a generic message if no specific scenario was parsed
            //=====================
            const failedList = (task.meta.failedScenarios && task.meta.failedScenarios.length)
                ? task.meta.failedScenarios
                : [];
            const firstFailed = failedList.length > 0 ? failedList[0] : '(unknown scenario)';
            const retryNum = task.meta.retry || 1;

            //=====================
            // Build context text for the agentic-debug skill
            // Includes the story tag, failed scenario name, and the full suite log tail
            //=====================
            const debugContext = [
                `Story: ${state.story.id} (tag ${state.story.tag})`,
                `Failed scenario: ${firstFailed}`,
                `Retry attempt: ${retryNum} of ${state.config.maxRetries}`,
                failedList.length > 1 ? `Other failed scenarios: ${failedList.slice(1).join(', ')}` : '',
                '',
                'Full suite test log tail:',
                task.meta.logTail || '(no log tail available)',
            ].filter(Boolean).join('\n');

            //=====================
            // Use the agentic-debug skill to generate a debug prompt
            // Runs cli/generatePromptForDebug.js which collects request logs and tracing data
            //=====================
            const debugResult = generateDebugPrompt(debugContext);
            if (!debugResult.ok) {
                log(`  -> warning: ${debugResult.error}. Proceeding with inline context only.`);
            }

            //=====================
            // Delegate to the agent: read the debug prompt (if generated), diagnose, and fix
            // The agent should use @debug_prompt.txt as additional context
            //=====================
            const agentInstructions = [
                `The full BDD test suite for ${state.story.id} (tag ${state.story.tag}) failed on retry #${retryNum}.`,
                `The primary failing scenario is: "${firstFailed}".`,
                failedList.length > 1 ? `Other failing scenarios: ${failedList.slice(1).join(', ')}.` : '',
                '',
                debugResult.ok
                    ? `A debug prompt has been generated at @debug_prompt.txt — read it for context including request logs and tracing data.`
                    : `Debug context:\n${debugContext}`,
                '',
                `Diagnose the root cause and fix the implementation or step definitions.`,
                `Do not weaken or skip tests. After fixing, the workflow will re-run the full suite.`,
            ].filter(Boolean).join('\n');

            return runAgent(task, agentInstructions);
        }

        case 'GEN_OPENAPI': {
            return runAgent(task,
                `Generate or update the OpenAPI schema for the endpoints implemented in this story, written to ` +
                `server/schema.json. Follow specs/api_rules.md.`);
        }

        case 'MARK_STORY_COMPLETED': {
            setStoryFlag(state.story.id, 'done', 'true');
            setStoryFlag(state.story.id, 'in_progress', 'false');
            state.story.status = 'completed';
            return { ok: true };
        }

        case 'FINISH': {
            //=====================
            // Final task — emit a clear completion marker and exit immediately.
            // We must call process.exit(0) explicitly here (rather than relying
            // on runLoop -> finishOutcome) because a detached child (the dev
            // server spawned by restartServer) can keep the event loop pinned
            // even after .unref(), forcing the user to Ctrl-C the runner. The
            // workflow has finished all work successfully at this point, so a
            // hard exit with code 0 is the correct, observable signal.
            //=====================
            task.status = 'done';
            task.finishedAt = now();
            task.error = null;
            task.error_details = null;
            progress(`COMPLETED ${state.story.id}`);
            progress(`DONE ${task.key}`);
            persist();
            console.log(`✓ ${task.key}`);
            console.log('TASK FINISHED');
            emitTrace('[finished] handle FINISH', { result: { ok: true, exitCode: 0 } });
            releaseLock();
            process.exit(0);
        }

        default:
            return { ok: false, error: 'unknown task type ' + task.type };
    }
}

/* ------------------------------ control loop ------------------------------ */

function stopRequested() {
    if (STOP) return true;
    const raw = readSafe(CONTROL_FILE);
    if (!raw) return false;
    try { return JSON.parse(raw).stop === true; } catch { return false; }
}
function clearStop() { STOP = false; try { fs.writeFileSync(CONTROL_FILE, JSON.stringify({ stop: false })); } catch { /* ignore */ } }

//=====================
// isWorkflowCompleted
// Returns true when the story is in completed state OR every task in the tree
// has reached a terminal status that the loop would otherwise skip ('done',
// 'superseded', 'failed_continued'). Used by `step <task.key>` so we can warn
// the user before re-running a task on a finished workflow — they may be
// pointing at the wrong directory or have already shipped this story.
//=====================
function isWorkflowCompleted() {
    //=====================
    // Defensive guard: state may not be loaded yet when the caller checks
    // (e.g. before ensureInitialized). Treat that as "not completed" so we
    // never fabricate a confirmation prompt without real evidence.
    //=====================
    if (!state || !Array.isArray(state.tasks)) return false;
    //=====================
    // Authoritative signal: the story itself is marked completed (via the
    // MARK_STORY_COMPLETED handler / setStoryFlag). We trust this over a
    // per-task scan because it's set deliberately by the workflow.
    //=====================
    if (state.story && state.story.status === 'completed') return true;
    //=====================
    // Fallback: every task is in a terminal state firstActionable() skips.
    // Covers workflows that finished but didn't reach MARK_STORY_COMPLETED
    // (e.g. the user ran each task individually) — still "nothing left to do".
    //=====================
    return state.tasks.every((t) =>
        t.status === 'done' ||
        t.status === 'superseded' ||
        t.status === 'failed_continued');
}

//=====================
// promptUserConfirmation
// Reads a yes/no answer from stdin. Returns true ONLY for an explicit "y"
// or "yes" (case-insensitive). Anything else — including an empty line, an
// EOF / closed stdin, or any other text — is treated as "no" so a typo or a
// piped-in blank line cannot accidentally green-light a destructive re-run.
//=====================
function promptUserConfirmation(question) {
    return new Promise((resolve) => {
        const readline = require('node:readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        //=====================
        // Single-fire guard
        // Both rl.question's callback and the 'close' event can fire (e.g. if
        // stdin closes after the answer is delivered). We resolve exactly once
        // so callers see a deterministic boolean.
        //=====================
        let resolved = false;
        const finish = (value) => {
            if (resolved) return;
            resolved = true;
            try { rl.close(); } catch { /* ignore double-close */ }
            resolve(value);
        };
        rl.question(question, (answer) => {
            const normalized = String(answer || '').trim().toLowerCase();
            finish(normalized === 'y' || normalized === 'yes');
        });
        rl.on('close', () => finish(false));
    });
}

//=====================
// promptUserChoice
// Reads a single-character menu choice from stdin and resolves to one of
// `validChoices`. Any other input — empty line, EOF/closed stdin, an
// out-of-range string — resolves to `defaultChoice`, which callers should
// set to the safest option (typically "stop") so a typo or a piped blank
// line never silently executes a destructive branch.
//=====================
function promptUserChoice(question, validChoices, defaultChoice) {
    return new Promise((resolve) => {
        const readline = require('node:readline');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        let resolved = false;
        const finish = (value) => {
            if (resolved) return;
            resolved = true;
            try { rl.close(); } catch { /* ignore double-close */ }
            resolve(value);
        };
        rl.question(question, (answer) => {
            const normalized = String(answer || '').trim();
            finish(validChoices.includes(normalized) ? normalized : defaultChoice);
        });
        rl.on('close', () => finish(defaultChoice));
    });
}

// first task that still needs attention: pending or (terminally) failed.
// 'done' and 'superseded' are passed over; 'running'/'blocked' are removed by sanitize.
// `excludeKeys` (optional) lets the caller mask out additional keys for the
// current pass — used by runLoop to honor "skip" choices at the human-in-the-loop
// pre-task gate without mutating persistent state.
function firstActionable(excludeKeys) {
    for (const t of state.tasks) {
        if (t.status === 'done' || t.status === 'superseded' || t.status === 'failed_continued') continue;
        if (excludeKeys && excludeKeys.has(t.key)) continue;
        return t;
    }
    return null;
}

function sanitize(resetFailed) {
    emitTrace('[running] sanitize', { inputs: { resetFailed } });
    // recover from a crash / prior block: anything mid-flight goes back to pending.
    // failed stays sticky unless this is an explicit resume (resetFailed).
    const restored = [];
    for (const t of state.tasks) {
        if (t.status === 'running' || t.status === 'blocked') { restored.push({ key: t.key, from: t.status, to: 'pending' }); t.status = 'pending'; }
        else if (t.status === 'failed' && resetFailed) {
            restored.push({ key: t.key, from: 'failed', to: 'pending' });
            t.status = 'pending';
            t.error = null;
            t.error_details = null;
        }
    }
    emitTrace('[finished] sanitize', { result: { restored } });
}

function handleFailure(t) {
    emitTrace('[running] handleFailure', { inputs: { taskKey: t.key, taskType: t.type, kind: t.kind, attempts: t.attempts, maxAttempts: t.maxAttempts, retry: t.meta && t.meta.retry } });
    if (t.type === 'RUN_TEST') {
        const k = (t.meta.retry || 0) + 1;
        if (k > state.config.maxRetries) {
            // Test execution failed after all retries — record the errored scenario
            // and continue with the next one instead of halting the whole workflow.
            // The detailed reason is in error_memories.md; the task is marked
            // failed_continued so firstActionable() skips past it.
            appendError(t);
            t.status = 'failed_continued';
            const scn = (t.meta && t.meta.scenarioName) || '(unknown scenario)';
            const featNum = t.meta && t.meta.featureNum;
            const firstLine = String(t.error || 'unknown').split('\n')[0];
            progress(`SKIPPED ${t.key} — feature ${featNum} scenario "${scn}" failed after ${k - 1} debug/retry attempt(s); reason: ${firstLine}. Continuing with next scenario.`);
            emitTrace('[finished] handleFailure', { result: { recovered: true, reason: 'run_test_max_retries_exceeded_continued', attemptedRetry: k, maxRetries: state.config.maxRetries } });
            return true;
        }
        // this attempt is superseded by a debug + retry pair, not a terminal failure
        t.status = 'superseded';
        const base = t.meta.baseKey;
        // Forward the failed run's log tail into the DEBUG meta so the DEBUG
        // handler can build an agentic-debug prompt without re-reading the log.
        const logTail = (t.error_details && t.error_details.log_tail) || '';
        const dbg = makeTask(`${base}.debug#${k}`, 'DEBUG', `${base}: debug failing test (#${k})`, 'agent',
            { ...t.meta, retry: k, logTail });
        const rt = makeTask(`${base}.run_test#${k}`, 'RUN_TEST', `${base}: re-run scenario test (#${k})`, 'deterministic',
            { ...t.meta, retry: k, baseKey: base });
        spliceAfter(state.tasks, t.key, [dbg, rt]);
        emitTrace('[finished] handleFailure', { result: { recovered: true, reason: 'queued_debug_and_retry', spliced: [dbg.key, rt.key] } });
        return true;
    }
    if (t.type === 'RUN_FULL_SUITE') {
        //=====================
        // Recover RUN_FULL_SUITE by splicing a DEBUG_FULL_SUITE + retry pair
        // Retries until maxRetries is reached, then mark as failed_continued
        // and continue so the workflow does not halt — user will review manually
        //=====================
        const k = (t.meta.retry || 0) + 1;
        if (k > state.config.maxRetries) {
            appendError(t);
            t.status = 'failed_continued';
            const firstLine = String(t.error || 'unknown').split('\n')[0];
            progress(`SKIPPED ${t.key} — full suite failed after ${k - 1} debug/retry attempt(s); reason: ${firstLine}. NEEDS REVIEW. Continuing with next task.`);
            emitTrace('[finished] handleFailure', { result: { recovered: true, reason: 'full_suite_max_retries_exceeded_continued', attemptedRetry: k, maxRetries: state.config.maxRetries } });
            return true;
        }
        // this attempt is superseded by a debug + retry pair, not a terminal failure
        t.status = 'superseded';

        //=====================
        // Extract failed scenarios and log tail from the error details
        // These are passed to the DEBUG_FULL_SUITE task so the agent knows what to fix
        //=====================
        const failedScenarios = (t.error_details && t.error_details.failed_scenarios) || [];
        const logTail = (t.error_details && t.error_details.log_tail) || '';

        const dbgKey = `story.full_suite.debug#${k}`;
        const dbg = makeTask(dbgKey, 'DEBUG_FULL_SUITE', `Debug full suite failure (#${k})`, 'agent', {
            retry: k,
            failedScenarios: failedScenarios,
            logTail: logTail,
        });
        const rt = makeTask(`story.full_suite#${k}`, 'RUN_FULL_SUITE', `Re-run full suite (#${k})`, 'deterministic',
            { retry: k });
        spliceAfter(state.tasks, t.key, [dbg, rt]);
        emitTrace('[finished] handleFailure', { result: { recovered: true, reason: 'full_suite_queued_debug_and_retry', spliced: [dbg.key, rt.key] } });
        return true;
    }
    if (t.kind === 'agent' && t.attempts < t.maxAttempts) {
        t.status = 'pending';
        emitTrace('[finished] handleFailure', { result: { recovered: true, reason: 'agent_retry', attempts: t.attempts, maxAttempts: t.maxAttempts } });
        return true;
    }
    // Max attempts reached for this task — record the error and mark it
    // failed_continued so firstActionable() skips past it. The workflow does
    // not halt; the user will review the skipped task manually after the run.
    appendError(t);
    t.status = 'failed_continued';
    const firstLine = String(t.error || 'unknown').split('\n')[0];
    progress(`SKIPPED ${t.key} (${t.type}) — failed after ${t.attempts} attempt(s) of ${t.maxAttempts}; reason: ${firstLine}. NEEDS REVIEW. Continuing with next task.`);
    emitTrace('[finished] handleFailure', { result: { recovered: true, reason: 'max_attempts_exceeded_continued', attempts: t.attempts, maxAttempts: t.maxAttempts } });
    return true;
}

async function runLoop(mode, targetTaskKey) {
    emitTrace('[running] runLoop', { inputs: { mode, targetTaskKey: targetTaskKey || null, storyId: state.story.id, taskCount: state.tasks.length } });
    state.mode = mode;
    persist();
    //=====================
    // skippedInThisRun
    // Tracks tasks the user chose to "skip" at the human-in-the-loop pre-task
    // gate during the current invocation. Kept in memory only — we want the
    // tasks to remain `pending` on disk so a future `resume` can pick them
    // back up, while ensuring firstActionable() does not re-offer them this
    // pass (which would otherwise loop the gate forever on the same key).
    //=====================
    const skippedInThisRun = new Set();
    while (true) {
        if (stopRequested()) {
            state.mode = 'idle'; persist(); progress('Run stopped by user');
            emitTrace('[finished] runLoop', { result: { outcome: 'STOPPED' } });
            return 'STOPPED';
        }

        //=====================
        // Task selection
        // In targeted mode the caller has chosen a specific task by key (the
        // `step <task.key>` flow), already validated and reset its status in
        // execute(). We look it up directly instead of asking firstActionable()
        // — the latter would skip it whenever the workflow is completed or the
        // task itself is in a terminal state, which is exactly the situation
        // targeted mode exists to handle.
        //=====================
        const task = targetTaskKey
            ? state.tasks.find((t) => t.key === targetTaskKey)
            : firstActionable(skippedInThisRun);
        if (!task) {
            state.mode = 'idle'; persist();
            emitTrace('[finished] runLoop', { result: { outcome: 'DONE' } });
            return 'DONE';
        }

        //=====================
        // Human-in-the-loop pre-task gate (#0)
        // Before a task starts, ask the user what to do with it. Only fires
        // when humanInTheLoop is enabled and the loop is iterating over
        // firstActionable() — targeted (`step <key>`) runs skip the gate
        // because the user already chose the task by typing its key.
        //   (1) execute    — fall through to normal execution
        //   (2) skip       — leave the task pending, exclude it from the
        //                    current pass, advance to the next actionable
        //   (3) mark done  — set status to 'done' and advance. Warns first
        //                    when the task would have spliced child tasks
        //                    (EXPAND_FEATURE_GROUPS, CREATE_GHERKIN), since
        //                    marking those done by hand leaves the subtree
        //                    unexpanded.
        //   (4) stop       — halt the run cleanly; `resume` picks up here.
        // Sticky-failure short-circuit below intentionally runs AFTER this
        // gate so the user gets one chance to mark-done / skip / stop a
        // task that previously failed before we just bail out.
        //=====================
        if (state.config && state.config.humanInTheLoop && !targetTaskKey) {
            emitTrace('[running] runLoop pre-task gate', {
                inputs: { taskKey: task.key, taskType: task.type, taskTitle: task.title, taskStatus: task.status },
            });
            const expandsChildren = task.type === 'EXPAND_FEATURE_GROUPS' || task.type === 'CREATE_GHERKIN';
            log('');
            log(`I'm going to execute the task: ${task.key} — ${task.title}.`);
            if (expandsChildren) {
                logYellow(`  ⚠ This task normally splices child tasks into the queue when it succeeds.`);
                logYellow(`     Marking it done by hand will skip that expansion — downstream tasks will NOT be created.`);
            }
            const choice = await promptUserChoice(
                `What do you want to do?  (1) execute  (2) skip  (3) mark as done  (4) stop : `,
                ['1', '2', '3', '4'],
                '4',
            );
            emitTrace('[finished] runLoop pre-task gate', { result: { taskKey: task.key, choice } });
            if (choice === '2') {
                skippedInThisRun.add(task.key);
                progress(`SKIP ${task.key} by user at human-in-the-loop pre-task gate (left pending)`);
                log(`  -> skipped (left pending). Resume later to pick it up again.`);
                continue;
            }
            if (choice === '3') {
                task.status = 'done';
                task.finishedAt = now();
                task.error = null;
                task.error_details = null;
                persist();
                progress(`DONE ${task.key} (marked done by user at human-in-the-loop pre-task gate)`);
                log(`✓ ${task.key} (marked done by user)`);
                continue;
            }
            if (choice === '4') {
                state.mode = 'idle'; persist();
                progress(`Run stopped by user at human-in-the-loop pre-task gate before ${task.key}`);
                log('\n⏸ stopped at user choice. Run `resume` to continue.');
                emitTrace('[finished] runLoop', { result: { outcome: 'STOPPED', reason: 'human_in_the_loop_pre_task_gate', lastTaskKey: task.key } });
                return 'STOPPED';
            }
            // choice === '1' → fall through to normal execution
        }
        //=====================
        // Sticky-failure short-circuit
        // Only meaningful in non-targeted mode: if the next actionable task is
        // already marked failed, halt so the user can inspect it. In targeted
        // mode the caller explicitly reset the task to 'pending' before
        // entering the loop, so this branch should never trigger — but we still
        // guard against it so a future caller skipping the reset doesn't loop
        // forever re-running a stuck task.
        //=====================
        if (task.status === 'failed' && !targetTaskKey) {
            state.mode = 'idle'; persist();
            emitTrace('[finished] runLoop', { result: { outcome: 'FAILED', taskKey: task.key } });
            return 'FAILED';
        }

        task.status = 'running';
        task.startedAt = now();
        task.attempts += 1;
        persist();
        progress(`START ${task.key} (${task.type}) attempt ${task.attempts}`);
        log(`▶ ${task.key}  (${task.title})`);
        emitTrace(`[running] START ${task.key} (${task.type}) attempt ${task.attempts}`, { inputs: { taskKey: task.key, taskType: task.type, attempt: task.attempts } });

        let res;
        try { res = await handle(task); }
        catch (e) {
            const stack = String((e && e.stack) || e);
            const message = String((e && e.message) || e);
            res = {
                ok: false,
                error: `unhandled exception in handler: ${message.split('\n')[0]}`,
                errorDetails: makeErrorDetails(task, {
                    summary: `unhandled exception in handler for task ${task.key}`,
                    reason: message,
                    operation: `handle(${task.type})`,
                    stack_trace: stack,
                    suggested_fix:
                        'An exception was thrown inside the worflow.js handler — this is either a worflow.js bug or an invariant violation ' +
                        '(e.g. a file the handler expected to exist was deleted between runs). Read the stack trace to find the failing line. ' +
                        'Common causes: (1) state.json was edited by hand and is now inconsistent; (2) artifacts from a prior step were removed; ' +
                        '(3) the agent left files in a half-written state. After fixing, `node worflow.js resume`.',
                }),
            };
        }

        if (res.blocked) {
            task.status = 'blocked';
            task.error = res.message;
            persist();
            progress(`BLOCKED ${task.key}`);
            state.mode = 'idle';
            persist();
            log('\n⏸ blocked: ' + res.message);
            emitTrace('[finished] runLoop iteration', { result: { taskKey: task.key, status: 'blocked' } });
            emitTrace('[finished] runLoop', { result: { outcome: 'BLOCKED', taskKey: task.key } });
            return 'BLOCKED';
        }

        if (res.ok) {
            task.status = 'done';
            task.finishedAt = now();
            task.error = null;
            task.error_details = null;
            //=====================
            // Splice expanded children — always, including targeted mode.
            // Deduplicate by key so re-running a task via `step` never inserts
            // a second copy of scenario tasks that already exist in the tree.
            //=====================
            if (res.expand && res.expand.length) {
                const existingKeys = new Set(state.tasks.map((t) => t.key));
                const toSplice = res.expand.filter((t) => !existingKeys.has(t.key));
                if (toSplice.length) spliceAfter(state.tasks, task.key, toSplice);
            }
            persist();
            progress(`DONE ${task.key}`);
            log(`✓ ${task.key}`);
            emitTrace('[finished] runLoop iteration', { result: { taskKey: task.key, status: 'done', expanded: (res.expand && !targetTaskKey) ? res.expand.map(e => e.key) : [] } });
        } else {
            task.status = 'failed';
            task.error = res.error;
            task.error_details = res.errorDetails || null;
            persist();
            const errStr = String(res.error || 'unknown error');
            const firstLine = errStr.split('\n')[0];
            // progress.txt gets the one-line summary plus an indented full block,
            // so a tail of the log still tells you *why* it failed.
            const progressBlock = `FAILED ${task.key}: ${firstLine}\n` +
                errStr.split('\n').slice(1).map((l) => '    ' + l).join('\n');
            progress(progressBlock.replace(/\s+$/, ''));
            logErrorBlock(`✗ ${task.key} FAILED — ${firstLine}`, errStr.split('\n').slice(1).join('\n'));
            if (task.error_details && task.error_details.suggested_fix) {
                logRedBold('  Suggested fix:');
                for (const line of String(task.error_details.suggested_fix).split('\n')) logRed('    ' + line);
            }
            //=====================
            // Skip handleFailure in targeted mode ONLY for task types that do
            // not have a debug/retry pipeline. For RUN_TEST / RUN_FULL_SUITE
            // we want the splice-DEBUG-and-retry behavior even when the user
            // re-ran the task directly with `step <key>` — that's the whole
            // point of the pipeline. For every other type the original
            // behavior stands: report the failure and stop; the user can
            // `resume` to re-engage normal orchestration.
            //=====================
            if (targetTaskKey && task.type !== 'RUN_TEST' && task.type !== 'RUN_FULL_SUITE') {
                emitTrace('[finished] runLoop iteration', { result: { taskKey: task.key, status: 'failed', targeted: true, error: firstLine } });
                state.mode = 'idle'; persist();
                emitTrace('[finished] runLoop', { result: { outcome: 'FAILED', taskKey: task.key, targetTaskKey } });
                return 'FAILED';
            }
            const recovered = handleFailure(task);
            persist();
            emitTrace('[finished] runLoop iteration', { result: { taskKey: task.key, status: 'failed', recovered, finalStatus: task.status, error: firstLine } });
            if (task.status === 'failed_continued') {
                logYellowBold(`⚠ ${task.key} SKIPPED — max attempts reached. NEEDS REVIEW.`);
                logYellow('  The workflow will continue with the next task. Fix this manually after the run.');
                logYellow('  Details recorded in error_memories.md and progress.txt.');
            }
            if (!recovered) {
                state.mode = 'idle'; persist();
                emitTrace('[finished] runLoop', { result: { outcome: 'FAILED', taskKey: task.key } });
                return 'FAILED';
            }
        }

        //=====================
        // Targeted-mode early return
        // We ran exactly the task the user requested. Pause now instead of
        // advancing to firstActionable() — calling it after a completed
        // workflow would return null and report DONE, which is misleading,
        // and in any other state it would silently start running other tasks
        // the user did not ask for.
        //
        // Exception: when handleFailure() spliced a DEBUG + retry pair after a
        // RUN_TEST / RUN_FULL_SUITE failure it marks the current task
        // 'superseded'. In that case we keep looping so the freshly-spliced
        // follow-up tasks run under the same `step <key>` invocation — the
        // user asked to run this test, and the whole point of the pipeline is
        // to debug-and-retry it.
        //=====================
        if (targetTaskKey && task.status !== 'superseded') {
            state.mode = 'idle'; persist();
            emitTrace('[finished] runLoop', { result: { outcome: 'PAUSED', targetTaskKey } });
            return 'PAUSED';
        }

        if (mode === 'step') {
            state.mode = 'idle'; persist();
            emitTrace('[finished] runLoop', { result: { outcome: 'PAUSED' } });
            return 'PAUSED';
        }

        //=====================
        // Human-in-the-loop post-task gate (#2)
        // After a task completes successfully and we are about to advance to
        // the next one, ask the user whether to continue. Only fires when:
        //   - humanInTheLoop is enabled,
        //   - the loop intends to iterate further (not step/targeted),
        //   - the task succeeded (we skip this on failure/recovery so the
        //     user is not asked to confirm a retry they did not request),
        //   - there is still actionable work left in the queue.
        // A "no" answer is treated as a clean stop, not a failure: state is
        // saved as-is and `resume` will pick up at the next pending task.
        //=====================
        if (state.config && state.config.humanInTheLoop && res.ok && firstActionable()) {
            emitTrace('[running] runLoop continue gate', { inputs: { lastTaskKey: task.key } });
            const goOn = await promptUserConfirmation(
                'Review the work done. Is it ok to go ahead to the next task? (y/n): '
            );
            emitTrace('[finished] runLoop continue gate', { result: { lastTaskKey: task.key, goOn } });
            if (!goOn) {
                state.mode = 'idle'; persist();
                progress(`Run stopped by user at human-in-the-loop review after ${task.key}`);
                log('\n⏸ stopped at user review. Run `resume` to continue.');
                emitTrace('[finished] runLoop', { result: { outcome: 'STOPPED', reason: 'human_in_the_loop_continue_gate', lastTaskKey: task.key } });
                return 'STOPPED';
            }
        }
    }
}

/* --------------------------------- lock ----------------------------------- */

function acquireLock() {
    ensureDir(WF_DIR);
    if (fs.existsSync(LOCK_FILE)) {
        const pid = parseInt(readSafe(LOCK_FILE) || '0', 10);
        if (pid && pid !== process.pid && isAlive(pid)) {
            die(`another runner is active (pid ${pid}). Use "node caal.jsstop" or wait for it to finish.`);
        }
    }
    fs.writeFileSync(LOCK_FILE, String(process.pid));
}
function releaseLock() { try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch { /* ignore */ } }

function onSigint() {
    sigints += 1;
    if (sigints >= 2) { console.log('\nforce exit.'); releaseLock(); process.exit(130); }
    STOP = true;
    try { fs.writeFileSync(CONTROL_FILE, JSON.stringify({ stop: true, at: now() })); } catch { /* ignore */ }
    console.log('\nstop requested — finishing the current action, then halting (Ctrl-C again to force).');
}

/* ------------------------------- commands --------------------------------- */

function parseFlags(args) {
    const flags = {};
    const rest = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--agent') flags.agent = args[++i];
        else if (a === '--warmup') flags.warmup = parseFloat(args[++i]);
        else if (a === '--max-retries') flags.maxRetries = parseInt(args[++i], 10);
        //=====================
        // --base-prompt <file>: path to the base prompt file used as a reference
        // when composing per-task prompts. Falls back to env WORKFLOW_BASE_PROMPT_FILE
        // and finally to the WORKFLOW_BASE_PROMPT constant. Resolved against ROOT
        // at bootstrap so a relative path remains valid across resume invocations.
        //=====================
        else if (a === '--base-prompt') flags.basePrompt = args[++i];
        //=====================
        // --agent-idle-timeout <sec>: kill the agent if it produces no output
        // for this many seconds. 0 (default) disables the watchdog. Also
        // readable from env WORKFLOW_AGENT_IDLE_TIMEOUT_SEC for users who
        // want a per-shell default without retyping the flag.
        //=====================
        else if (a === '--agent-idle-timeout') flags.agentIdleTimeout = parseFloat(args[++i]);
        //=====================
        // --user_stories_file <path>: path to the full user-stories markdown
        // file (e.g. docs/requirements/user_stories.md) that contains all
        // user-story sections. Combined with --user_story_to_run, the start
        // command extracts the requested section into a per-story spec file.
        //=====================
        else if (a === '--user_stories_file') flags.userStoriesFile = args[++i];
        //=====================
        // --user_story_to_run <number>: numeric identifier of the user story
        // to scaffold (e.g. 019, 7, 134). Normalised to a 3-digit padded
        // string at bootstrap so the spec folder/file are always named
        // user_story_XXX / USXXX.md regardless of how the user typed it.
        //=====================
        else if (a === '--user_story_to_run') flags.userStoryToRun = args[++i];
        //=====================
        // --human_in_the_loop [true|false]: when true, every step pauses twice
        // for user review — once after the agent composes the task-specific
        // prompt (so the user can read/edit it before the agent executes), and
        // once after the step completes (so the user can decide whether to
        // continue to the next task). Accepts an explicit "true" / "false" or
        // a bare flag (treated as true). Defaults to false / off.
        //=====================
        else if (a === '--human_in_the_loop') {
            const next = args[i + 1];
            if (next === 'true' || next === 'false') {
                flags.humanInTheLoop = next === 'true';
                i++;
            } else {
                flags.humanInTheLoop = true;
            }
        }
        else if (a === '--yes') flags.yes = true;
        else rest.push(a);
    }
    return { flags, rest };
}

function bootstrap(file, flags) {
    emitTrace('[running] bootstrap', { inputs: { file, flags } });
    const story = parseStory(file);
    ensureDir(WF_DIR);
    ensureStoriesToml(story);
    //=====================
    // Resolve the base prompt file path
    // Precedence: --base-prompt > env WORKFLOW_BASE_PROMPT_FILE > WORKFLOW_BASE_PROMPT.
    // We resolve against ROOT so a relative path supplied on the command line
    // remains valid for later resume/step runs regardless of cwd at that time.
    //=====================
    const rawBasePrompt = flags.basePrompt || process.env.WORKFLOW_BASE_PROMPT_FILE || WORKFLOW_BASE_PROMPT;
    const basePromptFile = path.resolve(ROOT, rawBasePrompt);

    //=====================
    // Agent idle-timeout resolution
    // Precedence matches every other config knob: CLI flag > env > built-in
    // default. Stored in milliseconds so the watchdog code stays in one unit.
    //=====================
    const envIdleSec = parseFloat(process.env.WORKFLOW_AGENT_IDLE_TIMEOUT_SEC);
    const idleSec = Number.isFinite(flags.agentIdleTimeout)
        ? flags.agentIdleTimeout
        : (Number.isFinite(envIdleSec) ? envIdleSec : null);
    const agentIdleTimeoutMs = idleSec != null && idleSec > 0
        ? Math.round(idleSec * 1000)
        : DEFAULT_AGENT_IDLE_TIMEOUT_MS;

    state = {
        version: 1,
        story,
        mode: 'idle',
        config: {
            agentCmd: flags.agent || process.env.AGENT_CMD || null,
            warmupMs: Number.isFinite(flags.warmup) ? Math.round(flags.warmup * 1000) : DEFAULT_WARMUP_MS,
            maxRetries: Number.isInteger(flags.maxRetries) ? flags.maxRetries : DEFAULT_MAX_RETRIES,
            basePromptFile,
            agentIdleTimeoutMs,
            //=====================
            // humanInTheLoop — when true, the run loop pauses at three gates
            // around every task: a pre-task choice prompt (execute / skip /
            // mark done / stop), then for agent steps a compose-vs-execute
            // review of the task prompt, and finally a continue prompt after
            // the task completes. Off by default so the autonomous flow is
            // preserved when the flag isn't passed.
            //=====================
            humanInTheLoop: !!flags.humanInTheLoop,
            //=====================
            // stepAgents — map of task.key -> shell command, used to override
            // the global agentCmd for individual steps. Managed via the
            // set-step-agent / unset-step-agent / list-step-agents commands.
            //=====================
            stepAgents: {},
        },
        tasks: backbone(),
        createdAt: now(),
        updatedAt: now(),
    };
    persist();
    progress(`Bootstrapped ${story.id} — "${story.title}"`);
    log(`initialized ${story.id} — "${story.title}" (tag ${story.tag})`);
    log(`base prompt: ${path.relative(ROOT, basePromptFile) || basePromptFile}` +
        (fs.existsSync(basePromptFile) ? '' : ' (missing — agent will be warned)'));
    if (!state.config.agentCmd) {
        log('note: no agent configured. Creative steps will block with a written prompt until you set');
        log('      --agent "<cmd>" or AGENT_CMD, or complete them manually and `resume`.');
    }
    if (state.config.humanInTheLoop) {
        log('human-in-the-loop: ON — before each task you choose execute/skip/mark-done/stop;');
        log('                   each agent step then runs in two phases (compose, execute) with a review gate');
        log('                   between them, and the runner asks before advancing to the next task.');
    }
    emitTrace('[finished] bootstrap', { result: { storyId: story.id, storyTitle: story.title, storyTag: story.tag, taskCount: state.tasks.length, agentCmd: state.config.agentCmd, humanInTheLoop: state.config.humanInTheLoop } });
}

function ensureInitialized(maybeFile, flags) {
    emitTrace('[running] ensureInitialized', { inputs: { maybeFile, flags } });
    if (loadState()) {
        // allow late agent/config overrides on subsequent commands
        if (flags && flags.agent) state.config.agentCmd = flags.agent;
        if (flags && Number.isFinite(flags.warmup)) state.config.warmupMs = Math.round(flags.warmup * 1000);
        if (flags && Number.isInteger(flags.maxRetries)) state.config.maxRetries = flags.maxRetries;
        //=====================
        // Late override of the base prompt file
        // Supports passing --base-prompt on step/run/resume to point the agent
        // at a different reference file without resetting the workflow. Also
        // back-fills config saved before this feature existed.
        //=====================
        if (flags && flags.basePrompt) {
            state.config.basePromptFile = path.resolve(ROOT, flags.basePrompt);
        } else if (!state.config.basePromptFile) {
            state.config.basePromptFile = path.resolve(ROOT, process.env.WORKFLOW_BASE_PROMPT_FILE || WORKFLOW_BASE_PROMPT);
        }
        //=====================
        // Late override / back-fill of agentIdleTimeoutMs
        // Allows step/run/resume to change the watchdog without reset, and
        // adds the field to state.config when loading a state.json saved
        // before this feature existed.
        //=====================
        if (flags && Number.isFinite(flags.agentIdleTimeout)) {
            state.config.agentIdleTimeoutMs = flags.agentIdleTimeout > 0
                ? Math.round(flags.agentIdleTimeout * 1000)
                : 0;
        } else if (state.config.agentIdleTimeoutMs == null) {
            const envIdleSec = parseFloat(process.env.WORKFLOW_AGENT_IDLE_TIMEOUT_SEC);
            state.config.agentIdleTimeoutMs = Number.isFinite(envIdleSec) && envIdleSec > 0
                ? Math.round(envIdleSec * 1000)
                : DEFAULT_AGENT_IDLE_TIMEOUT_MS;
        }
        //=====================
        // Late override / back-fill of humanInTheLoop.
        // Lets the user toggle the review gates on a step/run/resume command
        // without resetting the workflow, and defaults the field to off for
        // state files saved before this feature existed.
        //=====================
        if (flags && typeof flags.humanInTheLoop === 'boolean') {
            state.config.humanInTheLoop = flags.humanInTheLoop;
        } else if (state.config.humanInTheLoop == null) {
            state.config.humanInTheLoop = false;
        }
        //=====================
        // Back-fill stepAgents for state files saved before this feature existed.
        //=====================
        if (!state.config.stepAgents || typeof state.config.stepAgents !== 'object') {
            state.config.stepAgents = {};
        }
        emitTrace('[finished] ensureInitialized', { result: { source: 'loaded_state', storyId: state.story.id } });
        return;
    }
    if (maybeFile) {
        bootstrap(maybeFile, flags || {});
        emitTrace('[finished] ensureInitialized', { result: { source: 'bootstrapped', storyId: state.story.id } });
        return;
    }
    die('no workflow initialized. Run: node caal.jsstart <story.md>');
}

function finishOutcome(outcome) {
    emitTrace('[running] finishOutcome', { inputs: { outcome } });
    releaseLock();
    const exit = { DONE: 0, PAUSED: 0, STOPPED: 0, BLOCKED: 0, FAILED: 1 }[outcome] ?? 0;
    if (outcome === 'DONE') log('\nworkflow complete.');
    else if (outcome === 'PAUSED') log('\npaused after one action. Run `step`, `run`, or `status`.');
    else if (outcome === 'STOPPED') log('\nstopped. Run `resume` to continue.');
    else if (outcome === 'FAILED') log('\nhalted on a failure. Fix it (see error_memories.md), then `resume` to retry from the failed step.');
    const skipped = (state && state.tasks) ? state.tasks.filter((x) => x.status === 'failed_continued') : [];
    if (skipped.length) {
        logYellowBold(`\n⚠ ${skipped.length} task(s) were SKIPPED after exhausting retries — NEEDS REVIEW:`);
        for (const x of skipped) logYellow('  - ' + x.key + (x.error ? `: ${String(x.error).split('\n')[0]}` : ''));
        logYellow('See error_memories.md for full details.');
    }
    emitTrace('[finished] finishOutcome', { result: { outcome, exitCode: exit, skippedCount: skipped.length } });
    process.exit(exit);
}

async function execute(mode, maybeFile, flags, opts) {
    emitTrace('[running] execute', { inputs: { mode, maybeFile, flags, opts } });
    ensureInitialized(maybeFile, flags);
    acquireLock();
    process.on('SIGINT', onSigint);
    clearStop();
    sanitize(!!(opts && opts.resetFailed));
    persist();

    //=====================
    // Targeted single-task execution (step <task.key>)
    // When the caller specifies a task key we validate it exists, prompt the
    // user for confirmation if the workflow is in completed state, then reset
    // the chosen task to a clean 'pending' status so runLoop can execute it
    // exactly once. Reset covers every terminal status the task could be in —
    // done, failed, failed_continued, superseded, blocked — because the user
    // explicitly asked for it to run again, and stale attempts / error_details
    // would otherwise leak from the prior run into trace logs and progress.txt.
    //=====================
    const targetTaskKey = opts && opts.targetTaskKey;
    emitTrace('[running] execute', { task: targetTaskKey, inputs: { mode, maybeFile, flags, opts } });

    if (targetTaskKey) {
        const task = state.tasks.find((t) => t.key === targetTaskKey);
        emitTrace('[info] tasks in state', { tasks: state.tasks });

        if (!task) {
            releaseLock();
            die(`task not found: ${targetTaskKey}. Run "status" to see task keys.`);
        }
        //=====================
        // Completed-state confirmation gate
        // The whole point of this branch is to let the user re-run a task on a
        // workflow that's already done — but it's also easy to do by accident
        // (wrong directory, wrong story). We surface the situation and require
        // an explicit "yes" before proceeding. Anything else aborts cleanly.
        //=====================
        if (isWorkflowCompleted()) {
            logYellowBold('');
            logYellowBold(`⚠ The workflow for ${state.story.id} is in COMPLETED state.`);
            logYellow(`You requested to run task "${targetTaskKey}" anyway.`);
            logYellow('This will execute the task even though the story is marked completed.');
            const confirmed = await promptUserConfirmation('Run this task? (yes/no): ');
            if (!confirmed) {
                log('aborted by user.');
                releaseLock();
                emitTrace('[finished] execute', { result: { mode, outcome: 'ABORTED_BY_USER', targetTaskKey } });
                process.exit(0);
            }
        }
        //=====================
        // Clean-slate reset of the targeted task
        // Wipe attempts/timestamps/errors so the iteration in runLoop looks
        // like a first run and the user-facing logs aren't polluted by stale
        // error_details from whatever caused the original failure (if any).
        //=====================
        task.status = 'pending';
        task.attempts = 0;
        task.error = null;
        task.error_details = null;
        task.startedAt = null;
        task.finishedAt = null;
        persist();
        progress(`User requested re-run of task ${targetTaskKey} (workflow status: ${state.story.status})`);
    }

    const outcome = await runLoop(mode, targetTaskKey);
    emitTrace('[finished] execute', { result: { mode, outcome } });
    finishOutcome(outcome);
}

function cmdStatus() {
    emitTrace('[running] cmdStatus', { inputs: {} });
    if (!loadState()) {
        console.log('no workflow initialized in this directory.');
        emitTrace('[finished] cmdStatus', { result: { initialized: false } });
        return;
    }
    const t = state.tasks;
    const by = (s) => t.filter((x) => x.status === s).length;
    console.log(`story:    ${state.story.id} — ${state.story.title}`);
    console.log(`status:   ${state.story.status}    mode: ${state.mode}    tag: ${state.story.tag}`);
    console.log(`source:   ${state.story.sourceFile}`);
    console.log(`agent:    ${state.config.agentCmd ? state.config.agentCmd : '(none — creative steps will block)'}`);
    console.log(`human_in_the_loop: ${state.config.humanInTheLoop ? 'ON (pre-task choice gate, compose-prompt review, post-task continue gate)' : 'off'}`);
    const overrideCount = Object.keys(state.config.stepAgents || {}).length;
    if (overrideCount > 0) {
        console.log(`agent overrides: ${overrideCount} per-step (run \`list-step-agents\` to see)`);
    }
    console.log(`tasks:    ${t.length} total | done ${by('done')} | pending ${by('pending')} | running ${by('running')} | failed ${by('failed')} | blocked ${by('blocked')} | skipped ${by('failed_continued')}`);
    const cur = t.find((x) => x.status === 'running')
        || t.find((x) => x.status === 'blocked')
        || t.find((x) => x.status === 'failed')
        || t.find((x) => x.status === 'pending');
    console.log(`next:     ${cur ? `${cur.key} (${cur.status})` : '— all actions done —'}`);
    if (stopRequested()) console.log('stop:     requested (runner halts at next boundary)');
    const lastErr = [...t].reverse().find((x) => x.error);
    if (lastErr) {
        console.log(`last err: ${lastErr.key}: ${String(lastErr.error).split('\n')[0]}`);
        const d = lastErr.error_details;
        if (d) {
            if (d.reason) console.log(`reason:   ${String(d.reason).split('\n')[0]}`);
            if (d.exit_code !== undefined && d.exit_code !== null) {
                console.log(`exit:     ${d.exit_code}${d.exit_reason ? ` (${d.exit_reason})` : ''}`);
            }
            if (d.log_file) console.log(`log:      ${d.log_file}`);
            if (d.suggested_fix) {
                console.log('suggested fix:');
                for (const line of String(d.suggested_fix).split('\n')) console.log('  ' + line);
            }
        }
    }
    console.log('');
    const marks = { done: '✓', pending: '·', running: '▶', failed: '✗', blocked: '⏸', superseded: '–', failed_continued: '⚠' };
    for (const x of t) console.log(`  ${marks[x.status] || '?'} ${x.key}`);
    emitTrace('[finished] cmdStatus', { result: { storyId: state.story.id, mode: state.mode, totals: { total: t.length, done: by('done'), pending: by('pending'), running: by('running'), failed: by('failed'), blocked: by('blocked') } } });
}

function cmdStop() {
    emitTrace('[running] cmdStop', { inputs: {} });
    ensureDir(WF_DIR);
    fs.writeFileSync(CONTROL_FILE, JSON.stringify({ stop: true, at: now() }));
    console.log('stop requested. The runner will halt after the current action.');
    emitTrace('[finished] cmdStop', { result: { controlFile: path.relative(ROOT, CONTROL_FILE) } });
}

function cmdReset(flags) {
    // Note: this trace is emitted before .workflow/ is wiped, so the row is
    // also deleted along with the rest of the trace file. That's intentional —
    // a reset clears all history including the trace log.
    emitTrace('[running] cmdReset', { inputs: { confirmed: !!flags.yes } });
    if (!flags.yes) { console.log('this clears .workflow/ state. Re-run with --yes to confirm.'); return; }
    try { fs.rmSync(WF_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
    console.log('workflow state cleared.');
}

//=====================
// cmdSetStepAgent — record a per-step agent override.
// Stored in state.config.stepAgents keyed by exact task.key. We warn (but do
// not refuse) when the key isn't currently in the task tree, because tasks
// like feature_*.scenario_*.* are only created after CREATE_GHERKIN expands
// them — users may legitimately want to set the override ahead of time.
//=====================
function cmdSetStepAgent(key, cmd) {
    emitTrace('[running] cmdSetStepAgent', { inputs: { key, cmd } });
    if (!loadState()) die('no workflow initialized.');
    if (!key) die('set-step-agent needs a task key: node caal.jsset-step-agent <task.key> "<cmd>"');
    if (!cmd || !String(cmd).trim()) {
        die('set-step-agent needs a non-empty agent command. To remove an override, use: node caal.jsunset-step-agent <task.key>');
    }
    if (!state.config.stepAgents || typeof state.config.stepAgents !== 'object') {
        state.config.stepAgents = {};
    }
    const known = state.tasks.some((t) => t.key === key);
    if (!known) {
        logYellow(`warning: task key "${key}" is not currently in the task tree.`);
        logYellow('The override will be applied if/when that task appears (e.g. after CREATE_GHERKIN expands scenario tasks).');
    }
    state.config.stepAgents[key] = cmd;
    persist();
    console.log(`set agent for ${key}: ${cmd}`);
    emitTrace('[finished] cmdSetStepAgent', { result: { key, cmd, known } });
}

function cmdUnsetStepAgent(key) {
    emitTrace('[running] cmdUnsetStepAgent', { inputs: { key } });
    if (!loadState()) die('no workflow initialized.');
    if (!key) die('unset-step-agent needs a task key: node caal.jsunset-step-agent <task.key>');
    const map = state.config.stepAgents || {};
    if (!(key in map)) {
        console.log(`no per-step agent override set for ${key}`);
        emitTrace('[finished] cmdUnsetStepAgent', { result: { key, removed: false } });
        return;
    }
    delete map[key];
    state.config.stepAgents = map;
    persist();
    console.log(`removed agent override for ${key}`);
    emitTrace('[finished] cmdUnsetStepAgent', { result: { key, removed: true } });
}

function cmdListStepAgents() {
    emitTrace('[running] cmdListStepAgents', { inputs: {} });
    if (!loadState()) die('no workflow initialized.');
    const map = state.config.stepAgents || {};
    const keys = Object.keys(map).sort();
    console.log(`global agent: ${state.config.agentCmd || '(none)'}`);
    if (keys.length === 0) {
        console.log('no per-step agent overrides set.');
    } else {
        console.log(`per-step overrides (${keys.length}):`);
        for (const k of keys) console.log(`  ${k} -> ${map[k]}`);
    }
    emitTrace('[finished] cmdListStepAgents', { result: { count: keys.length } });
}

function usage() {
    console.log([
        'usage:',
        '  node caal.js start --user_stories_file <path> --user_story_to_run <number>',
        '                          [--agent "<cmd>"] [--base-prompt <file>] [--warmup <sec>]',
        '                          [--max-retries <n>] [--agent-idle-timeout <sec>]',
        '                          [--human_in_the_loop true]',
        '                             Extracts US-<number> from <user_stories_file> (a full user-stories',
        '                             markdown file) into specs/user_story_XXX/USXXX.md, appends the',
        '                             "(the part below should be compiled by devs)" block from',
        '                             docs/user_story_template.md, then runs the workflow — whose first',
        '                             task asks the agent to complete that dev block before continuing.',
        '  node caal.js step [<task.key>]',
        '                             run exactly one action and pause. With no argument,',
        '                             runs the next actionable task. With a task key (see',
        '                             `status`), re-runs that specific task — even if the',
        '                             workflow is completed (the runner will prompt for',
        '                             confirmation before executing on a completed workflow).',
        '  node caal.js run       run autonomously to the end (or until stop/block/fail)',
        '  node caal.js resume    sanitize and run to the end',
        '  node caal.js status    print progress (read-only, anytime)',
        '  node caal.js stop      request a cooperative halt',
        '  node caal.js done <task.key>      Run "status" to see keys.',
        '  node caal.js set-step-agent <task.key> "<cmd>"',
        '                             override the agent command for a single step. The override',
        '                             takes precedence over --agent / AGENT_CMD for that step only.',
        '                             Setting an override for a task key that does not yet exist',
        '                             (e.g. a scenario task before CREATE_GHERKIN runs) is allowed —',
        '                             a warning is printed and the override applies when the task',
        '                             is created. Spliced retries (debug#N, run_test#N) do NOT',
        '                             inherit the override automatically.',
        '  node caal.js unset-step-agent <task.key>',
        '                             remove a per-step agent override.',
        '  node caal.js list-step-agents',
        '                             print the global agent and all per-step overrides.',
        '  node caal.js reset --yes',
        '',
        'flags:',
        '  --user_stories_file <path>',
        '                      path to the full user-stories markdown file (required by `start`).',
        '                      Example: docs/requirements/user_stories.md',
        '  --user_story_to_run <number>',
        '                      identifier of the story to scaffold (required by `start`). Padded to',
        '                      3 digits internally, so 19, 019, and "US-019" all map to US-019.',
        '  --agent "<cmd>"     shell command that runs your agent. The agent receives env',
        '                      WORKFLOW_PROMPT_FILE and WORKFLOW_TASK; exit 0 = success.',
        '  --base-prompt <f>   path to the base prompt file the agent reads as a reference',
        `                      when composing per-task prompts. Default: ${path.relative(ROOT, WORKFLOW_BASE_PROMPT) || WORKFLOW_BASE_PROMPT}`,
        '                      (env: WORKFLOW_BASE_PROMPT_FILE).',
        '  --warmup <sec>      seconds to wait after restarting the dev server before tests.',
        '  --max-retries <n>   max debug/retry cycles per failing scenario or full suite.',
        '  --agent-idle-timeout <sec>',
        '                      kill the agent if it produces no output (stdout or stderr) for this many',
        '                      seconds. 0 (default) disables the watchdog. Stream-json result detection',
        '                      is always on — claude exits as soon as it emits the result event.',
        '                      (env: WORKFLOW_AGENT_IDLE_TIMEOUT_SEC).',
        '  --human_in_the_loop [true|false]',
        '                      when true, every step pauses for user review at three gates.',
        '                      (1) Pre-task gate, before the task starts: the runner prints',
        '                          "I\'m going to execute the task: <key> — <title>." and prompts',
        '                          "What do you want to do?  (1) execute  (2) skip  (3) mark as done',
        '                          (4) stop". "skip" leaves the task pending and moves on to the next',
        '                          actionable one for this run; "mark as done" sets it done and advances',
        '                          (a warning is printed if the task would have spliced child tasks);',
        '                          "stop" halts cleanly (run `resume` to continue).',
        '                      (2) Compose-review gate, for agent steps: the agent first composes a',
        '                          task-specific prompt and exits, then the runner prints the path and',
        '                          prompts "Review the composed prompt and tell me: it\'s ok to proceed?',
        '                          You can change it if you want (y/n)". You may edit the file before',
        '                          answering — the execute phase reads whatever is on disk.',
        '                      (3) Continue gate, after each successful task: the runner prompts',
        '                          "Review the work done. Is it ok to go ahead to the next task? (y/n)".',
        '                      A "no" / "stop" at any gate halts the workflow cleanly (run `resume` to',
        '                      continue). Off by default. The bare flag (no value) is treated as true.',
    ].join('\n'));
}

/* --------------------------------- main ----------------------------------- */

async function main() {
    const argv = process.argv.slice(2);
    const cmd = argv[0];
    const { flags, rest } = parseFlags(argv.slice(1));
    emitTrace('[START]---|___|---[START]', { inputs: { cmd, flags, rest, pid: process.pid } });

    switch (cmd) {
        case 'start': {
            //=====================
            // start now extracts a single user-story section from a full
            // user-stories markdown file into specs/user_story_XXX/USXXX.md,
            // concatenates the template's dev block, then runs the workflow
            // — whose first task (story.complete_dev_parts) delegates to the
            // agent to fill the dev block. The two flags below are mandatory
            // because the prior positional <story.md> form has been removed.
            //=====================
            if (loadState()) die('a workflow is already initialized here. Use `run`/`step`/`status`, or `reset --yes` first.');
            if (!flags.userStoriesFile) die('start needs --user_stories_file <path> (e.g. docs/requirements/user_stories.md)');
            if (flags.userStoryToRun == null || flags.userStoryToRun === '') {
                die('start needs --user_story_to_run <number> (e.g. 019)');
            }
            const padded = normalizeStoryNumber(flags.userStoryToRun);
            const storiesFileAbs = path.resolve(ROOT, flags.userStoriesFile);
            const templateFileAbs = path.resolve(ROOT, 'docs', 'user_story_template.md');
            const { title, sectionText } = extractStorySection(storiesFileAbs, padded);
            const devPart = extractTemplateDevPart(templateFileAbs);
            const specFile = setupStorySpecFile(padded, sectionText, devPart);
            log(`extracted US-${padded} ("${title}") into ${path.relative(ROOT, specFile)}`);
            emitTrace('[running] start command', { storiesFileAbs, templateFileAbs, devPart, specFile, flags } );
            await execute('run', specFile, flags);
            break;
        }
        case 'step': {
            //=====================
            // step accepts either a story-file path (when the workflow has not
            // been initialized yet) or a task key (when the workflow exists
            // and the user wants to run one specific task — including on a
            // completed workflow). We disambiguate by peeking at state.json
            // directly rather than calling loadState(): we don't want to
            // mutate the global `state` before ensureInitialized has a chance
            // to apply CLI/env overrides. If parsing fails for any reason we
            // fall through to the original "treat the arg as a file" behavior.
            //=====================
            const arg = rest[0];
            let targetTaskKey = null;
            let maybeFile = arg;
            let parsedState = null;
            if (arg) {
                const stateRaw = readSafe(STATE_FILE);
                if (stateRaw) {
                    try {
                        parsedState = JSON.parse(stateRaw);
                        if (parsedState && Array.isArray(parsedState.tasks) &&
                            parsedState.tasks.some((t) => t.key === arg)) {
                            targetTaskKey = arg;
                            maybeFile = undefined;
                        }
                    } catch { /* invalid state.json; treat arg as a story file */ }
                }
            }
            emitTrace('[running] step command', {
                inputs: {
                    maybeFile,
                    flags,
                    targetTaskKey,
                    parsedState: parsedState ? {
                        version: parsedState.version,
                        storyId: parsedState.story?.id,
                        storyStatus: parsedState.story?.status,
                        taskCount: parsedState.tasks?.length,
                        mode: parsedState.mode,
                    } : null,
                },
            });

            await execute('step', maybeFile, flags, { targetTaskKey });
            break;
        }
        case 'run': await execute('run', rest[0], flags); break;
        case 'resume': await execute('run', rest[0], flags, { resetFailed: true }); break;
        case 'status': cmdStatus(); break;
        case 'stop': cmdStop(); break;
        case 'reset': cmdReset(flags); break;
        case 'done': {
            const key = rest[0];
            if (!key) die('done needs a task key: node caal.jsdone <key>\nRun "status" to see keys.');
            cmdDone(key);
            break;
        }
        case 'set-step-agent': {
            const key = rest[0];
            const stepCmd = rest[1];
            if (!key || !stepCmd) {
                die('set-step-agent needs both a task key and a command:\n' +
                    '  node caal.jsset-step-agent <task.key> "<cmd>"\n' +
                    'Run "status" or "list-step-agents" to see existing keys.');
            }
            cmdSetStepAgent(key, stepCmd);
            break;
        }
        case 'unset-step-agent': {
            const key = rest[0];
            if (!key) die('unset-step-agent needs a task key: node caal.jsunset-step-agent <task.key>');
            cmdUnsetStepAgent(key);
            break;
        }
        case 'list-step-agents': cmdListStepAgents(); break;
        case undefined:
        case '-h':
        case '--help': usage(); break;
        default: console.error('unknown command: ' + cmd); usage(); process.exit(1);
    }
}

//=====================
// Top-level error trap
// Async main means an unhandled rejection inside any awaited call (runLoop,
// _runAgentInner, etc.) would otherwise die silently with an UnhandledPromise
// warning. We surface it and release the lock so subsequent runs are not
// blocked by a stale .workflow/lock.
//=====================
main().catch((err) => {
    console.error('fatal: ' + ((err && err.stack) || err));
    releaseLock();
    process.exit(1);
});