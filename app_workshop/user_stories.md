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