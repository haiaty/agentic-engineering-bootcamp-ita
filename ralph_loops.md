

1) modulo 1: Che cos'è un ralph loop?

"Ralph is an autonomous AI agent loop that runs AI coding tools (Pi or Claude Code) repeatedly until all PRD/user stories items are complete. Each iteration is a fresh instance with clean context."



Esempio pseudocodice:

```
for i in $(seq 1 $MAX_ITERATIONS); do
echo ""
echo "==============================================================="
echo "  Ralph Iteration $i of $MAX_ITERATIONS"
echo "==============================================================="

    cat RALPH.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log
    
fi
```










Esempi in giro sul web:

- Ralph Auto Loop - Autonomous AI coding agent that implements specs: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh
- Ralph Wiggum - Long-running AI agent loop: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh
- Ralph loop plugin by claude: https://claude.com/plugins/ralph-loop

MOLTO IMPORTANTE: farlo girare dentro un container con utenza non root e senza alcun accesso a file contenenti parametri di ambienti di produzione


2) modulo2:  Come lo possiamo usare? 


opzione: 1 - in maniera interattiva con la shell

```
pi --provider omlx --model Qwen3.8-27B-8bit
ralph/RALPH_ESEMPIO_1.md 
```

opzipne 2 - lanciare da linea di comando


```

# non vedi nulla ma solo il risultato finale, cioè la risposta dell'LLM
cat ralph/RALPH_ESEMPIO_1.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve

# vedi esattamente tutto quello che fa: 
cat ralph/RALPH_ESEMPIO_1.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log

```

Esempio 2 - far scrivere un report sulla qualità del codice.

cat ralph/RALPH_ESEMPIO_2.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log


Esempio 3 - Singola funzionalità.

cat ralph/RALPH_ESEMPIO_3_SINGLE_SHOT.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log



Esempio 4 -Full user story

cat ralph/RALPH_ESEMPIO_4_NEW_USER_STORY.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log



other possible use cases:
- Generate scenarios to cover edge cases.
- Debug
- Code audits: security, concurrency, data integrity/consistency/transaction



Modulo resources:

- Ralph loop plugin by claude: https://claude.com/plugins/ralph-loop 
- First principles: https://www.youtube.com/watch?v=4Nna09dG_c0
- Ralph Auto Loop - Autonomous AI coding agent that implements specs: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh
- Ralph Wiggum - Long-running AI agent loop: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh


3) tips e cose da ricordare:

- usa sempre sandbox e dentro la sandbox non ci deve mai essere env o file con credenziali di produzione
- se lo devi far runnare di notte, ricordati di rimuovere lo sleep del pc  (sul mac puoi mettere caffeinate) o di runnarlo come screen (se sei un server remoto)
- 