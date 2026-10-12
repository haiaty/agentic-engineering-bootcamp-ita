
make durable execution and governance first-class. Workflows can persist through failures and pauses and resume from the last checkpoint; humans can inspect or modify state at interrupt points; the process can pause and resume later, especially for human review or long-running work. the team needs a trace of which route was taken and why; or multiple tools or model calls must share a durable state object.


- è una sorta di wrapper del ralph per poter gestire i problemi che si presentano con il ralph, tra i quali:

* cosa succede se ralph si rompe a metà dello sviluppo?  Come faccio a ripartire solo da un punto specifico e non fargli fare tutto di nuovo?
* Come faccio a stopparlo perchè ha generato un prompt sbagliato o perchè le scelte che ha fatto non sono quelle che voglio?
* Come faccio a sapere lo stato di dove si trova il loop? 
* e se volessi avere degli step che possono runnare in parallelo, tipo una volta finito e passato i test, posso runnare audit diversi in paralllelo.
* E se qualche test fallisce e lui va in loop perchè non riesce a farlo, come riparto dai test?
* E se volessi mettere degli eventi log per osservabilità su specifiche parti del flusso? 
* E se volessi reagire con degli eventi o hook quando certe fasi sono finite?



# quando non usarlo?

- se il task è in un singolo prompt ed è semplice o veloce
- una semplice estrazione strutturata, es: genera del json per lo stato attuale dell'applicazione
- se basta un singolo retry del prompt per sistemare il fallimento
- quaslasi attività che non è complessa e non richiede multi step

# quando usarlo?

- implementazione totale di totale user stories
- feature complete (es: aggiungere un ednpoint nuovo, fare un refactor pesante tipo cambio di storage, etc..)
- qualsiasi task complesso e avanzato che richiede più step per finire e che potrebbero durare tanto e rompersi nel mentre


# preqrequisiti per usarlo

- sapere la struttura di un buon prompt e come usare il metaprompting
- sapere che cos'è un agente AI e come usare un coding agent
- sapere bene che cos'è un ralph loop


# concepts principali

### base prompt

Il base prompt è un file Markdown che fa da "modello di riferimento" per tutti i prompt che CAAL manda all'agente. 

caal.js non contiene un template fisso per ogni task. 

Scrive invece un meta-prompt breve che dice all'agente: "leggi il base prompt, scrivi tu il prompt giusto per questo task, salvalo, poi eseguilo"

Quale file viene scelto (caal.js:3030), in ordine di priorità:                                                                                                                           
- il flag --base-prompt <file>                                                                                                                                                           
- la variabile d'ambiente WORKFLOW_BASE_PROMPT_FILE                                                                                                                                      
- il default in base al tipo di workflow (defaultBasePrompt, caal.js:595):                                                                                                               
- per una user story: RALPH_PROMPT_NEW_USER_STORY.md (caal.js:119)                                                                                                                     
- per un singolo task (feature o refactor): RALPH_PROMPT_TASK.md (caal.js:130). Ha un default separato perché il prompt delle user story parla di Gherkin e decomposizione, e su un    
task singolo confonderebbe l'agente.
-
  Se il file non esiste (caal.js:933), il workflow non si blocca. Avvisa l'agente con un WARNING e gli chiede di ricostruire il base prompt da AGENTS.md, docs/ e specs/, oppure di        
  procedere con il proprio giudizio

### i prompt specifici dei task vengono creati dall'agente con il metaprompting

Non c'è un prompt specifico per il task di tipo agentic. 

Praticamente caal usa il base prmpt come riferimento per far generare all'AI il prompt migliore da usare per fare il task.


 L'agente non riceve il contenuto del base prompt, ma solo il suo percorso, con la procedura da seguire:                    
a. leggere il base prompt e i documenti che cita;                                                                                                                                        
b. scrivere un prompt specifico per il task, tenendo solo le parti che servono;                                                                                                          
c. salvarlo in .workflow/prompts/<key>.composed.md;                                                                                                                                      
d. eseguire il task seguendo quel prompt.  

li puoi vedere in: si può rivedere e riusare (.workflow/prompts/)
volendo li puoi aggiustare e far ripartire

### modalità 

##### full autonomous

basta runnare 'run'

#### human in the loop

Passando il flag --human_in_the_loo l'agente scrive solo il prompt, poi si ferma perché una persona lo rivede



# Volendo Caal si può estendere per aggiungere nuovi step

- valutazione o pre approvazione umana e commit, deploy
- qualsiasi cosa vi venga in mente