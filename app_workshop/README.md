# App Workshop

Software project analytics built with the [Luminous architecture](LUMINOUS_ARCHITECTURE.md).

## Implemented user stories

- **US1 — File volatility** (`src/services/fileVolatility.js`): list the files of a git
  project ordered by how many revisions modified them (frequency, not changed lines),
  with stable alphabetical order for ties and an explicit message when the analyzed
  history range contains no modifications.

## CLI usage

```sh
# full history
node cli/run.js fileVolatility --repoPath=/path/to/repo

# only a history range (any git revision range works)
node cli/run.js fileVolatility --repoPath=/path/to/repo --range=HEAD~2..HEAD
```

Output is JSON: `analyzedRevisions`, `files` (ordered list of `{ path, changes }`)
and `message` (set only when the list is empty). Errors are reported as
`{ "status": "ERROR", "message": "..." }` with a non-zero exit code.

The `--key=value` flag names are exactly the keys of the service input contract,
and the same service can be bound to an HTTP route without changes (Luminous
service isolation).

## Tests

Executable BDD specifications (Gherkin) live in `tests/features/`, step
definitions in `tests/steps_definitions/`, organized by business domain
(see `.claude/skills/bdd-gherkin-feature-writer/SKILL.md`).

```sh
npm test
```
