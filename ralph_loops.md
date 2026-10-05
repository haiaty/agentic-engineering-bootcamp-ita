

1) modulo 1: Che cos'è un ralph loop?

"Ralph is an autonomous AI agent loop that runs AI coding tools (Pi or Claude Code) repeatedly until all PRD/user stories items are complete. Each iteration is a fresh instance with clean context."



Esempio:

```
for i in $(seq 1 $MAX_ITERATIONS); do
echo ""
echo "==============================================================="
echo "  Ralph Iteration $i of $MAX_ITERATIONS"
echo "==============================================================="

 cat RALPH_PROMPT_NEW_USER_STORY.md | claude -p \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --verbose \
    --output-format stream-json 2>&1 | tee claude-run-debug.log
    
    cat TEST.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log
    
    
fi
```


Esempio 1 - far salutare in una lingua:

cat ralph/RALPH_ESEMPIO_1.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve

cat ralph/RALPH_ESEMPIO_1.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log


Esempio 2 - far scrivere un report sulla qualità del codice.

cat ralph/RALPH_ESEMPIO_2.md | pi --print --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log







Esempi in giro sul web:

- Ralph Auto Loop - Autonomous AI coding agent that implements specs: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh
- Ralph Wiggum - Long-running AI agent loop: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh
- Ralph loop plugin by claude: https://claude.com/plugins/ralph-loop

MOLTO IMPORTANTE: farlo girare dentro un container con utenza non root e senza alcun accesso a file contenenti parametri di ambienti di produzione


2) modulo2:  Come lo possiamo usare? Nuova user story



opzione: 1 - in maniera interattiva con la shell

```
pi (o claude)
@RALPH_PROMPT_NEW_USER_STORY user story 2 of the file @user_stories
```

opzipne 2 - lanciare da linea di comando


```

cat RALPH_PROMPT_DEBUG.md | claude -p \
    --model "$MODEL" \
    --dangerously-skip-permissions \
    --verbose \
    --output-format stream-json 2>&1 | tee claude-run-debug.log

```

2) modulo2:  Come lo possiamo usare? Other use cases:

- Debug
- Singola funzionalità. See @RALPH_SINGLE_SHOT
- Generate scenarios to cover edge cases. See 



Modulo resources:

- Ralph loop plugin by claude: https://claude.com/plugins/ralph-loop 
- First principles: https://www.youtube.com/watch?v=4Nna09dG_c0
- Ralph Auto Loop - Autonomous AI coding agent that implements specs: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh
- Ralph Wiggum - Long-running AI agent loop: https://github.com/mikearnaldi/accountability/blob/main/ralph-auto.sh