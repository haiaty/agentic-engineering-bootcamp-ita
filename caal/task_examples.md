# caal — sviluppare un singolo task (feature o refactor) senza user story

Il comando `task` di `caal.js` permette di far sviluppare all'agente **una sola funzionalità o un refactor**
senza passare da una user story. Gli passi due cose:

1. **la definizione del task** — *cosa* fare (`--description` e/o `--task_file`);
2. **il prompt base** — *come* lavorare: convenzioni, regole, riferimenti (`--base-prompt`).

Il workflow eseguito è sempre:

```
task.plan        (agente)  -> scrive specs/tasks/<slug>/plan.md, non tocca il codice
task.implement   (agente)  -> implementa seguendo TASK.md + plan.md
task.regression  (runner)  -> npm run test:tag '@done'  (se fallisce: debug#k + retry#k)
task.finish      (runner)  -> chiude il workflow
```

---

## Prerequisiti

`caal.js` usa come root la **cartella da cui lo lanci**: lì cerca `package.json` (per `npm run test:tag`,
`npm run start:dev`, ...), crea `.workflow/`, `specs/tasks/`, `progress.txt`, ecc.
Quindi va lanciato dalla cartella del progetto:

```bash
cd /Code/app_workshop
node ../caal.js --help
```

Se c'è già un workflow inizializzato (di una user story o di un altro task), il comando `task` si rifiuta
di partire. Prima azzera lo stato:

```bash
node ../caal.js status        # controlla cosa c'è
node ../caal.js reset --yes   # cancella .workflow/ (non tocca specs/ né il codice)
```

### Il comando agente

L'agente è un qualsiasi comando shell che riceve il meta-prompt nel file indicato da `$WORKFLOW_PROMPT_FILE`
ed esce con codice 0 in caso di successo. Esempio con Claude Code (gli apici singoli sono importanti:
la variabile deve essere espansa al momento dell'esecuzione, non quando scrivi il comando):

```bash
export AGENT_CMD='claude -p "$(cat "$WORKFLOW_PROMPT_FILE")" --output-format stream-json --verbose --dangerously-skip-permissions'
```

Puoi passarlo con `--agent '...'` oppure, come negli esempi sotto, tramite la variabile `AGENT_CMD`.

---

## 1. Preparare la definizione del task

Per task brevi basta `--description`. Per task più articolati conviene un file markdown, per esempio
`specs/requests/export_csv_ordini.md`:

```markdown
# Export CSV degli ordini

Aggiungere un endpoint che esporta gli ordini in CSV.

## Requisiti
- GET /api/orders/export?from=YYYY-MM-DD&to=YYYY-MM-DD
- Colonne: id, data, cliente, totale, stato
- Solo gli utenti con ruolo admin possono esportare (403 altrimenti)
- Ogni export va registrato nella tabella di audit

## Fuori scope
- Export in altri formati (xlsx, pdf)
- Modifiche al frontend
```

`caal` copia tutto in `specs/tasks/<slug>/TASK.md`: lo slug deriva dal primo titolo `#` del file
(o dalla prima riga della descrizione). Se la cartella esiste già aggiunge `-2`, `-3`, …

## 2. Preparare il prompt base

Il prompt base **non** descrive il task: descrive le regole del progetto che l'agente deve rispettare.
L'agente lo legge e, per ogni step, compone un prompt specifico (salvato in
`.workflow/prompts/<task.key>.composed.md`).

Se non passi `--base-prompt`, viene usato `RALPH_PROMPT_TASK.md` nella root del progetto.
Un modello pronto è in `/Code/ralph/RALPH_PROMPT_TASK.md`; puoi copiarlo e personalizzarlo:

```bash
cp /Code/ralph/RALPH_PROMPT_TASK.md /Code/app_workshop/RALPH_PROMPT_TASK.md
```

Oppure puoi avere più prompt base specializzati, per esempio `prompts/REFACTOR_RULES.md`:

```markdown
You are working inside an existing codebase located in app_workshop/.

Reference files:
- Agent rules: `AGENTS.md`
- Architecture: `docs/architecture`
- Things learned: `learned.md`
- Errors to avoid: `error_memories.md`

Refactor rules:
- Observable behavior must not change: API contracts, responses, error codes, persisted data, audit rows.
- The existing tests are the specification. If they fail, fix the code, never the tests.
- Keep each change small; prefer moving code over rewriting it.
- Do not rename public endpoints, DB tables or columns.
- Before starting, list in plan.md the tests that cover the code you will touch.

Tests:
- Reload the server with: npm run reload:dev
- Regression: npm run test:tag @done (run by the workflow, not by you, during plan/implement)
- Debug failures with the skill .claude/skills/agentic-debug
```

---

## Esempi

### Esempio 1 — refactor con descrizione inline e prompt base dedicato

```bash
cd /Code/app_workshop
node ../caal.js task \
  --type refactor \
  --description "Estrarre la validazione degli ordini da src/routes/orders.js in un service dedicato (src/services/orderValidation.js), senza cambiare il comportamento delle API." \
  --base-prompt prompts/REFACTOR_RULES.md
```

Risultato:
- `specs/tasks/estrarre-la-validazione-degli-ordini-da/TASK.md` — la definizione;
- `specs/tasks/estrarre-la-validazione-degli-ordini-da/plan.md` — il piano scritto dall'agente;
- per un refactor l'agente ha l'istruzione esplicita di non cambiare il comportamento osservabile e,
  se la regressione `@done` fallisce, di correggere il codice e non i test.

### Esempio 2 — nuova feature da file, con il prompt base di default

```bash
cd /Code/app_workshop
node ../caal.js task \
  --type feature \
  --task_file specs/requests/export_csv_ordini.md
```

Non passando `--base-prompt` viene usato `RALPH_PROMPT_TASK.md` della root del progetto
(se manca, il run parte lo stesso ma l'agente riceve un avviso nel prompt).
Per una feature l'agente deve scrivere anche i test; gli scenari BDD vanno taggati `@done` così
entrano nella regressione.

### Esempio 3 — file + note aggiuntive inline

`--description` e `--task_file` si possono combinare: in `TASK.md` finiscono una sezione
`## Description` (il testo inline) e una sezione `## Details (from …)` (il contenuto del file).
Utile per aggiungere vincoli al volo senza modificare il file originale:

```bash
node ../caal.js task \
  --type feature \
  --task_file specs/requests/export_csv_ordini.md \
  --description "Limita l'export a massimo 10.000 righe; oltre, rispondi 422 con un messaggio chiaro." \
  --base-prompt prompts/FEATURE_RULES.md
```

### Esempio 4 — human in the loop: rivedere piano e prompt prima di implementare

```bash
node ../caal.js task \
  --type refactor \
  --task_file specs/requests/split_user_service.md \
  --base-prompt prompts/REFACTOR_RULES.md \
  --human_in_the_loop true
```

Per ogni step il runner si ferma tre volte:

1. **prima del task**: `(1) execute  (2) skip  (3) mark as done  (4) stop`;
2. **dopo la composizione del prompt** (solo step agente): l'agente scrive
   `.workflow/prompts/<task.key>.composed.md` e si ferma. Puoi aprirlo, modificarlo, e poi rispondere `y`:
   la fase di esecuzione usa il file così come l'hai lasciato su disco;
3. **dopo il task**: confermi se passare al successivo.

È il modo consigliato per i primi task: dopo `task.plan` puoi leggere (e correggere) `plan.md`
prima che parta `task.implement`.

### Esempio 5 — procedere un passo alla volta

`task` avvia subito il run. Se vuoi eseguire uno step alla volta, interrompi con `stop`
(o Ctrl-C) e poi usa `step`:

```bash
node ../caal.js stop             # da un altro terminale: si ferma al prossimo step
node ../caal.js status           # vedi task, piano, base prompt, prossimo step
node ../caal.js step             # esegue solo il prossimo step e si ferma
node ../caal.js step task.plan   # riesegue uno step specifico (es. dopo aver modificato TASK.md)
node ../caal.js resume           # riprende fino alla fine
```

### Esempio 6 — cambiare prompt base a metà workflow

Il prompt base è salvato nello stato, ma si può sostituire su `step`, `run` e `resume` senza resettare.
Per esempio, se il piano va bene ma vuoi regole più severe per l'implementazione:

```bash
node ../caal.js step task.plan --base-prompt prompts/REFACTOR_RULES.md
node ../caal.js resume --base-prompt prompts/REFACTOR_RULES_STRICT.md
```

Il nuovo prompt base resta attivo per gli step successivi (lo vedi in `status` alla riga `base prompt:`).

### Esempio 7 — un agente diverso solo per uno step

Per esempio un modello più potente per il piano e uno più veloce per il resto:

```bash
node ../caal.js set-step-agent task.plan 'claude -p "$(cat "$WORKFLOW_PROMPT_FILE")" --model opus --output-format stream-json --verbose --dangerously-skip-permissions'
node ../caal.js list-step-agents
```

`set-step-agent` richiede un workflow già inizializzato: lancialo dopo `task` (fermato con `stop`)
oppure con `--human_in_the_loop` scegliendo `stop` al primo gate.

---

## Cosa succede se qualcosa va storto

| Situazione | Comportamento |
|---|---|
| `task.plan` non produce `plan.md` | lo step fallisce e viene ritentato fino a 3 volte; poi viene marcato come saltato (⚠) e il workflow prosegue — controlla `status` ed `error_memories.md` |
| la regressione `@done` fallisce | vengono aggiunti `task.regression.debug#k` (l'agente diagnostica e corregge) e `task.regression#k` (rilancio), fino a `--max-retries` (default 3) |
| agente non configurato | gli step agente si bloccano scrivendo il prompt in `.workflow/prompts/`; puoi eseguirli a mano e poi `node ../caal.js done <task.key>` |
| `--type` diverso da `feature`/`refactor` | errore immediato |

## Dove trovare cosa

| File | Contenuto |
|---|---|
| `specs/tasks/<slug>/TASK.md` | definizione del task |
| `specs/tasks/<slug>/plan.md` | piano scritto dall'agente |
| `.workflow/prompts/<task.key>.md` | meta-prompt inviato all'agente |
| `.workflow/prompts/<task.key>.composed.md` | prompt specifico composto dall'agente a partire dal prompt base |
| `.workflow/tests__done.log` | log dell'ultima regressione |
| `progress.txt`, `error_memories.md`, `learned.md` | avanzamento, errori, cose imparate |
