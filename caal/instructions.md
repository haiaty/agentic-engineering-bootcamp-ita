

Per vedere quello che puoi fare (usage information):


```bash
# in the root of the Code folder inside the container:
cd /Code/app_workshop/ or cd /Code/app_workshop_sql/
node caal.js
```



```bash

node caal task --task_file task_for_caal_1.md --base-prompt PROMPT_TASK.md  --type feature --human-in-the-loop true --agent 'pi -p "$(cat "$WORKFLOW_PROMPT_FILE")" --approve --mode json 2>&1 | tee pi-run-debug.log'
```