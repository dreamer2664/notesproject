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

**Lo usi dal telefono?** L'AI locale segue il PC: se apri l'app sullo stesso computer (o da un altro dispositivo che raggiunge il tuo IP con Ollama in ascolto) funziona; dal 4G no, lì resta la ricerca nel libro. È il limite fisico di "niente server", non un dettaglio trascurabile.

**Se Ollama dice "origine bloccata"** (l'icona diventa rossa con "blocca questa origine"): stai aprendo l'app da un indirizzo che non è `localhost`. Soluzione, al prompt:

```
setx OLLAMA_ORIGINS "*"     # Windows, poi riavvia Ollama
# oppure
OLLAMA_ORIGINS=* ollama serve
```

---

## 3. Scrivere con la penna

Due posti diversi, stessa matita vettoriale (resta nitida a ogni zoom, e si esporta):

- **Sulle pagine del libro:** nel lettore, il pulsante penna (tasto `P`). Scrivi a mano libera sui margini, sull'immagine, sopra una figura. La gomma è anche il **tieni premuto Spazio**. Tutto resta salvato con la pagina, quindi se torni tra una settimana trovi i tuoi segni.
- **Negli appunti:** `/` su una riga vuota → *Handwriting*. Disegni un riquadro, `Fatto` per uscire. Il disegno vive dentro l'appunto e **viene esportato in Markdown come SVG**, quindi lo rivedi anche aprendo il file con un editor di testo.

Serve una Wacom? No: funziona col dito, col mouse, e con la penna del Surface/Chromebook/telefono-android-col-pen. Con il dito l'app ignora il palmo (rifiuto del palmo: scrivi pure appoggiando la mano).

Zoom nel lettore: `+` / `-`. Pagine: `←` `→`, `Spazio`, o il numero in alto.

---

## Cosa ho testato, e cosa no

Testato qui (in CI-like, con `npm test`): import di pagine da immagini + OCR pulito, estrazione testo PDF, tokenizzazione/stem in italiano, ranking BM25, chunking, penna (round-trip SVG, gomma, pressione), blocco-pagina dentro l'appunto (Markdown → file → di nuovo blocco), e l'intero flusso **libro in archivio → lettore → penna → ricerca → AI senza modello** renderizzato davvero (jsdom).

Non testato qui, quindi provalo tu per primo: OCR su 300 pagine vere, EPUB con DRM, penna su hardware reale, risposte di qwen2.5:3b.
