# User story 1 — File con maggiore volatilità in Git history

Come utente dell'app che analizza un progetto software,
voglio vedere da git la lista dei file modificati più spesso,
così da individuare rapidamente i file con maggiore volatilità e decidere dove concentrare l'analisi.


Criteri di accettazione

1. Dato un progetto con una cronologia delle modifiche, quando apro la vista della volatilità, vedo i file ordinati per numero di modifiche in ordine decrescente.
2. Per ogni file vedo almeno il percorso relativo e il numero di modifiche rilevate.
3. Il conteggio considera una modifica per ogni revisione in cui il file è stato modificato, nell'intervallo di cronologia analizzato; più modifiche allo stesso file nella stessa revisione contano una sola volta.
4. Se due file hanno lo stesso numero di modifiche, la lista usa il percorso del file in ordine alfabetico per dare un risultato stabile.
5. Se non ci sono modifiche nell'intervallo analizzato, vedo un messaggio esplicito e una lista vuota.
   Nota di ambito: per questa funzionalità la volatilità è misurata dalla frequenza delle modifiche, non dalla quantità di righe cambiate.




# User story 2 — Creare un summary degli ultimi commit

Come utente dell'app che analizza un progetto software,
voglio vedere da git un riepilogo degli ultimi commit,
così da capire rapidamente cosa è cambiato di recente nel progetto senza dover leggere la cronologia commit per commit.


Criteri di accettazione

1. Dato un progetto con una cronologia delle modifiche, quando apro la vista del summary, vedo gli ultimi N commit ordinati dal più recente al meno recente (N predefinito: 10).
2. Per ogni commit vedo almeno l'hash abbreviato, l'autore, la data e il messaggio (prima riga).
3. Per ogni commit vedo il numero di file modificati e il totale di righe aggiunte e rimosse.
4. In testa alla lista vedo un riepilogo aggregato dell'intervallo: numero di commit, numero di autori distinti, numero di file distinti toccati e intervallo di date coperto.
5. Posso cambiare il numero N di commit da includere nel summary; se N è maggiore dei commit disponibili, vedo tutti i commit presenti senza errori.
6. I commit di merge sono mostrati e indicati come tali, ma non vengono conteggiati due volte nei totali di file e righe modificate.
7. Se il progetto non ha commit, vedo un messaggio esplicito e una lista vuota.
   Nota di ambito: per questa funzionalità il summary si basa sui metadati e sulle statistiche di git, senza generare descrizioni in linguaggio naturale del contenuto delle modifiche.

