

Per vedere quello che puoi fare (usage information):


```bash
# in the root of the Code folder inside the container:
cd /Code/app_workshop/
node caal.js
```



```bash



node caal task --task_file tasks/TASK1.md --base-prompt tasks/RALPH_PROMPT_TASK.md  --type feature --human_in_the_loop true --agent 'pi -p "$(cat "$WORKFLOW_PROMPT_FILE")" --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log'
node caal task --task_file tasks/TASK1.md --base-prompt tasks/RALPH_PROMPT_TASK.md  --type feature --human_in_the_loop true --agent 'pi -p "$(cat "$WORKFLOW_PROMPT_FILE")" --provider omlx --model Qwen3.8-27B-8bit  --approve --mode json 2>&1 | tee pi-run-debug.log'
```