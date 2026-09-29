

cd path/folder/clone
docker compose up -d
docker exec -it agentic_bootcamp-agentic-1 bash

- dentro container:

configurare l'agente PI
pi
vi $HOME/.pi/agent/models.json

verificare che sia stato configurato correttamente:
pi --list-models

entrare dentro la folder dove faremo i task
cd /Code/app_workshop

lanciare pi dentro la cartella
pi --provider omlx --model Qwen3.6-35B-A3B-8bit


aprire poi phpstorm o qualsiasi editor 

# lanciare lo script

node cli/run.js fileVolatility --repoPath=../


# pi faq

- how to set reasoning option pi agent with command line?
For the Pi coding agent, set reasoning when you start it with --thinking:

pi --thinking high

The documented levels are off, minimal, low, medium, high, and xhigh; your model may support only some of them. Once Pi is running, use /thinking to change the level interactively.

- can i stop a prompt after i see the reasoning is wrong?
Yes. While Pi is working, press Esc to stop the current response. Then type a correction or a new prompt. 
More info: https://pi.dev/docs/latest/usage