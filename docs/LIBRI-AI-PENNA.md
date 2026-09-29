# Libri di testo, AI senza chiavi, penna

Tre cose nuove, tutte pensate per un PC da 8 GB senza account e senza canoni.
Leggere qui sotto vale 5 minuti: il resto lo scopri usando l'app.

---

## 1. Far entrare i libri (Sanoma, Zanichelli e compagnia)

**Cosa non si fa, e perché.** Non strappo i libri al reader della casa editrice: quei letti (My Place, My Digital Book, laZ online, Locklizard) mostrano pagine come JPG spappolati o HTML spezzato, e un estrattore si rompe il giorno dopo. Inoltre non c'è nessuna API da chiamare: non è che manchi la chiave, non esiste proprio il rubinetto.

**Cosa si fa.** Si prende il file che l'editore *già ti dà*. Quasi tutti lo danno, basta saper dove guardare:

| Editore | Dove guardare | Cosa ottieni |
|---|---|---|
| Zanichelli (laZ Ebook) | myZanichelli → il tuo titolo → **Scarica / Download ebook** | EPUB per Adobe Digital Editions, oppure ZIP/PDF per l'app offline |
| Sanoma (place.sanoma.it) | **My Digital Book** (hanno l'app, Win/Mac/Linux) → scarica il titolo; oppure **"libro liquido"** dal sito | libro offline in formato .db/.epub + le risorse (figure) in una cartella |
| Hoepli, De Agostini, Pearson… | voce "scarica l'ebook" / "app offline" | EPUB o PDF |
| Solo copie di pagine | cartella con `001.jpg, 002.jpg, …` | immagini → OCR |
| Nulla di niente | il testo che riesci a selezionare | "Ho solo il reader dell'editore" → libro a pagine vuote + testo incollato |

**In pratica:**

1. `Ctrl+Shift+B` (o ⌘K → *Import a book*, o la pagina **Testi**) → trascina il file.
2. Scegli: dimensione immagine di pagina (1500 va bene, 1200 se il disco è pieno), OCR, soggetto.
3. Importa. EPUB e PDF testuali: secondi. Scansioni e immagini: minuti (l'OCR gira sul tuo PC, con il modello **italiano già dentro l'app** — funziona anche senza internet).
4. Si apre il lettore: pagina a sinistra, tuoi strumenti a destra (**Testo / Appunti / AI / Cerca**).

**Se l'EPUB è protetto** (ti chiede Adobe ID): April → *Attiva dispositivo*, poi il file `.acsm` lo apre Adobe Digital Editions e Scarica l'EPUB. Quello che ADE scarica per i tuoi libri acquistati è importabile. Se un titolo non ha nessun download (succede, con alcuni "solo online"), l'unica strada onesta restano le pagine: screenshot → cartella → import immagini, oppure incolla il testo pagina per pagina (il campo c'è, nel lettore).

**Lo storage.** Un libro di 300 pagine a 1500px pesa ~40–90 MB di immagini. Se serve spazio: menu **Libro** (⋮ in alto a destra nel lettore) → *Togli solo le immagini*: resta il testo, quindi ricerca e AI continuano a funzionare, sparisce solo la copia fotografica della pagina.

**Sul telefono / sul cloud.** Dal menu **Libro** → *Esporta in un folder*: scrive `Titolo/Pagine/0001.md` (uno per pagina, con OCR e numero), e il tuo OneDrive/Syncthing li sincronizza sul telefono. L'app non ha un server suo: IndexedDB sul PC, cartella dovunque tu la voglia.

---

## 2. AI senza chiavi: parla solo col tuo PC

Niente Groq, niente Gemini, niente OpenRouter. L'app parla con **Ollama** su `127.0.0.1`, che è un programma sul tuo computer: nessuna chiave, nessun conto, nessun consumo. Se Ollama non c'è, l'AI non muore: fa *retrieval* e ti porta le frasi del libro con la pagina, in ordine di pertinenza (è già più utile di quanto sembri).

**Una volta sola:**

```
winget install Ollama.Ollama        # Windows  (Mac: brew install ollama)
ollama pull qwen2.5:3b              # ~2,6 GB, il modello testo consigliato
ollama pull qwen2.5vl:3b            # ~3 GB, se vuoi che legga figure e grafici
```

Poi basta: Ollama parte da solo all'avvio su Windows/Mac, l'app lo trova.

**Cosa scegliere con 8 GB**

| | modello | perché |
|---|---|---|
| testo | `qwen2.5:3b` | italiano decente, 3B, sta in RAM con il browser aperto |
| testo (alternativa) | `llama3.2:3b` | un filo meno bravo in italiano, più stabile sulle liste |
| figure/grafici | `qwen2.5vl:3b` | piccolo e con visione; `minicpm-v:8b` se hai più RAM e voglia di attendere |

**Aspettati la verità:** su un portatile vecchio, una domanda su una pagina richiede **20–60 secondi**. È il prezzo di girare in locale: non è lento per colpa dell'app. Se la risposta è troppo generica, alza *Caratteri di libro mandati al modello* (menu ⚙ in alto a destra nel lettore): più contesto, più lento.

**Tasti e comandi rapidi nel lettore:** i pulsanti sotto la risposta fanno le cose da studio (*Spiega questa pagina*, *Riassumi*, *Elenca definizioni*, *Genera domande per l'interrogazione*, *Descrivi la figura*, *Collega ad altri appunti*…). Le citazioni `(p. 128)` nella risposta sono **cliccabili**: ti portano alla pagina.

**"Studia le pagine in background"** (⚙ → ultima casella): l’AI legge una pagina alla volta, vicino a dove sei, e ne tiene una scheda (idee / definizioni / domande / collegamenti). Costo: minuti di CPU spenta in idle, non mentre lavori. Beneficio: le risposte dopo sono **più rapide** (meno testo da leggere) e **più ostinate a inventare**, perché partono dalla mappa invece che dal muro di parole. Nel lettore, scheda AI: *"L’AI ha già studiato 12/300 pagine"*.

**Lo usi dal telefono?** L'AI locale segue il PC: se apri l'app sullo stesso computer (o da un altro dispositivo che raggiunge il tuo IP con Ollama in ascolto) funziona; dal 4G no, lì resta la ricerca nel libro. È il limite fisico di "niente server", non un dettaglio trascurabile.

**Se Ollama dice "origine bloccata"** (l'icona diventa rossa con "blocca questa origine"): stai aprendo l'app da un indirizzo che non è `localhost`. Soluzione, al prompt:

```
setx OLLAMA_ORIGINS "*"     # Windows, poi riavvia Ollama
# oppure
OLLAMA_ORIGINS=* ollama serve
```

---

## 3. Screenshot → appunti (senza toccare internet)

`Ctrl+Shift+S` (o ⌘K → *Screenshot → appunti*, o il pulsante nella dashboard). Butta dentro anche 30-40 screenshot insieme: pagine fotografate, slide, screenshot del reader, appunti scritti a mano.

**Cosa sceglie lei, e cosa fa l'app**

| Manopola | Cosa cambia davvero |
|---|---|
| **Veloce** | max 8 immagini, 1 passata, ~700 token di risposta, nessuna flashcard, **zero web** |
| **Standard** | tutte le immagini, batch da 6, 2 passate (bozza → riscrittura + domande da esame), flashcard, 4 min minimi |
| **Profondo** | batch da 4 (legge meglio), max 1500px, ~2200 token, riscrive, aggiunge esempi, 10 min minimi |
| **Tempo minimo** | 0-25 min. Se finisce prima, l’avanzo non è tempo morto |
| **legge i pixel / OCR** | con un modello con visione (qwen2.5vl:3b) guarda davvero le figure; senza, usa Tesseract locale (gratis, offline) |

**Il tempo minimo funziona così:** finita la prima stesura, se sei ancora sotto il 60% del budget l’app chiede al modello *"cosa renderebbe lo studio di questa roba davvero più facile?"* e glielo fa avere: schema a albero, tabella di confronto, errori tipici, glossario, piano di ripasso in 3 giorni, altre flashcard. Se sei oltre, si ferma da sola: su un PC vecchio non ti fa aspettare per niente. Mettendo un minimo **senza** spuntare "auto", invece, il tempo se lo prende tutto.

**JUST FROM THE SCREENSHOTS:** è scritto nel motore, ed è testato (`npm run test:unit` → *scan: nothing in the writing prompts can reach the web*): i prompt che producono gli appunti contengono solo testo trascritto dalle tue immagini e nessun URL; ogni richiesta esce solo se l’endpoint è `localhost`/`127.0.0.1`, altrimenti **refusa prima di chiamare fetch**. Se il modello non ha nulla da leggere, non inventa: ti dice che dall’immagine non è uscito testo.

**YouTube, alla fine, se vuoi.** La casella *"cerca su YouTube SOLO il link"* è **spenta di default** e vale solo per Standard/Profondo. Se la accendi: il modello produce al massimo 4 frasi di ricerca (`YT: teorema di Taylor`), l’app le filtra (niente URL, niente siti, niente markup: una riga che non è una frase di ricerca viene buttata via) e ti mette davanti link alla **pagina di ricerca** di YouTube. L’app non apre nessun video, non legge nessuna pagina, non manda nessuna parola dei tuoi appunti a nessuno: apri tu, decidi tu.

**Cosa ne esce**
- appunti Markdown già nel formato giusto, con la trascrizione sotto (la puoi correggere e premere *Rigenera*: riscrive senza rileggere le immagini);
- flashcard → diventano blocchi `toggle` (domanda chiusa, risposta dentro): perfette per ripassare sull’appunto;
- le "cose in più" → un paragrafo separato, così lo butti via se non ti serve;
- **Crea appunto con tutto** (📸 in un topic "Screenshot"), oppure **Copia in fondo all’appunto aperto**.

Le immagini **non vengono salvate** nell’archivio (trenta PNG a 1300px brucerebbero il DB in un pomeriggio): restano la trascrizione e gli appunti, e la trascrizione è testo, quindi si cerca. Lo storico delle scansioni (testo, non immagini) è nella parte bassa della finestra: lo riapri se il browser è crashato a metà.

**Quanto dura, onestamente:** con `qwen2.5vl:3b` su un portatile vecchio da 8 GB, conta **20-40 s a immagine** per la lettura + 20-60 s per scrivere. Quaranta screenshot = 20-30 minuti. Con l’OCR locale è molto più veloce ma perde figure e formule scritte a mano. Se ti serve stanotte: Veloce su 8 immagini alla volta, stasera, e Standard sulle altre domani.

---

## 4. Scrivere con la penna

Due posti diversi, stessa matita vettoriale (resta nitida a ogni zoom, e si esporta):

- **Sulle pagine del libro:** nel lettore, il pulsante penna (tasto `P`). Scrivi a mano libera sui margini, sull'immagine, sopra una figura. La gomma è anche il **tieni premuto Spazio**. Tutto resta salvato con la pagina, quindi se torni tra una settimana trovi i tuoi segni.
- **Negli appunti:** `/` su una riga vuota → *Handwriting*. Disegni un riquadro, `Fatto` per uscire. Il disegno vive dentro l'appunto e **viene esportato in Markdown come SVG**, quindi lo rivedi anche aprendo il file con un editor di testo.

Serve una Wacom? No: funziona col dito, col mouse, e con la penna del Surface/Chromebook/telefono-android-col-pen. Con il dito l'app ignora il palmo (rifiuto del palmo: scrivi pure appoggiando la mano).

Zoom nel lettore: `+` / `-`. Pagine: `←` `→`, `Spazio`, o il numero in alto.

---

## Cosa ho testato, e cosa no

Testato qui (in CI-like, con `npm test`): import di pagine da immagini + OCR pulito, estrazione testo PDF, tokenizzazione/stem in italiano, ranking BM25, chunking, penna (round-trip SVG, gomma, pressione), blocco-pagina dentro l'appunto (Markdown → file → di nuovo blocco), e l'intero flusso **libro in archivio → lettore → penna → ricerca → AI senza modello** renderizzato davvero (jsdom).

Testato qui anche: i tre livelli di sforzo (fanno davvero cose diverse), il budget di tempo (si ferma al 60% in auto), il filtro sulle frasi di ricerca YouTube (URL e markup vengono rifiutati), il rifiuto di endpoint non locali, il parser delle schede di studio, e lo smoke test apre la finestra screenshot, verifica che "YouTube" parta spento e che il worker in background si fermi dicendo perché quando Ollama non c’è.

Non testato qui, quindi provalo tu per primo: OCR su 300 pagine vere, EPUB con DRM, penna su hardware reale, risposte di qwen2.5:3b, 40 screenshot veri nella finestra (qui non posso produrre immagini di pagine).
