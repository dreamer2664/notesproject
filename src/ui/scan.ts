import { createNote, createTopic, deleteScanRun, digestCount, digestFor, getBook, getNote, listScanRuns, listTopics, putScanRun, saveBlocks } from '../core/db'
import { dropDigests, onStudyChange, stopStudy, studyBook, studyState } from '../core/study'
import { uid } from '../core/util'
import type { Block } from '../core/types'
import {
  EFFORT,
  chat,
  fmtElapsed,
  prepareForScan,
  runScan,
  sanitiseQuery,
  type Effort,
  type ScanResult,
} from '../core/screenshot'
import { checkOllama, getAiSettings, mdToHtml } from '../core/ai'

import { el, toast } from './dom'
import { icons } from './icons'
import { App, routes } from './state'


/**
 * "Dump a pile of screenshots → get notes." The dialog is deliberately loud about
 * what it will and will not touch: images go to the local model, nothing goes to the
 * web unless the YouTube box is ticked (and then only a search *phrase*).
 */
export async function openScanDialog(preselect?: File[]) {
  const cfg = getAiSettings()
  const st = await checkOllama(cfg.endpoint)
  const visionOptions = [...new Set([cfg.vision, ...st.visionModels].filter(Boolean))]
  const textOptions = [...new Set([cfg.model, ...st.models].filter(Boolean))]
  const visionModel = visionOptions[0] ?? ''
  const textModel = textOptions[0] ?? cfg.model

  let files: File[] = []
  let prepared: string[] = []
  let busy = false
  const ac = new AbortController()
  let effort: Effort = 'standard'
  let autoTime = true
  let minutes = EFFORT.standard.minMinutes
  let useVision = !!visionModel
  let keepTranscript = true
  let allowWeb = false
  let lastResult: ScanResult | null = null

  const drop = el('div', { class: 'drop scan-drop' },
    el('b', { text: 'Butta qui dentro gli screenshot (anche 30-40 insieme)' }),
    el('p', { class: 'lede dim', text: 'Pagine di libro fotografate, slide, screenshot del reader, appunti scritti a mano. Le immagini vengono ridimensionate qui, nel browser: non vengono caricate da nessuna parte.' }))
  const picker = el('input', { type: 'file', multiple: 'true', class: 'hidden-file', accept: 'image/*' })
  picker.addEventListener('change', () => {
    if (picker.files?.length) void setFiles(Array.from(picker.files))
  })
  drop.addEventListener('click', () => picker.click())
  drop.addEventListener('dragover', (e: Event) => {
    e.preventDefault()
    drop.classList.add('over')
  })
  drop.addEventListener('dragleave', () => drop.classList.remove('over'))
  drop.addEventListener('drop', (e: DragEvent) => {
    e.preventDefault()
    drop.classList.remove('over')
    const list = Array.from(e.dataTransfer?.files ?? []).filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|webp|bmp|gif)$/i.test(f.name))
    if (!list.length) return toast('Trascina file immagine (o usa “sfoglia”)')
    void setFiles(list)
  })
  const thumbs = el('div', { class: 'scan-thumbs' })
  const clearBtn = el('button', { class: 'btn small ghost', type: 'button', text: 'Svuota' })
  clearBtn.addEventListener('click', () => void setFiles([]))

  async function setFiles(list: File[]) {
    files = list
    prepared = []
    thumbs.replaceChildren()
    const n = files.length
    if (!n) {
      drop.classList.remove('has-files')
      clearBtn.style.display = 'none'
      syncRun()
      return
    }
    drop.classList.add('has-files')
    clearBtn.style.display = ''
    for (const [i, f] of files.entries()) {
      thumbs.append(el('span', { class: 'scan-thumb empty', title: f.name, dataset: { i: String(i) }, text: String(i + 1) }))
    }
    thumbs.append(el('span', { class: 'scan-count', text: `${n} immagini · le preparo…` }))
    const maxSide = EFFORT[effort].maxSide
    let done = 0
    for (const [i, f] of files.entries()) {
      try {
        const url = await prepareForScan(f, maxSide)
        prepared[i] = url
        const slot = thumbs.querySelector(`.scan-thumb[data-i="${i}"]`)
        if (slot) {
          slot.classList.remove('empty')
          slot.textContent = ''
          ;(slot as HTMLElement).style.backgroundImage = `url(${url})`
        }
      } catch {
        prepared[i] = ''
      }
      done++
      if (done % 4 === 0 || done === n) thumbs.querySelector('.scan-count')?.replaceChildren(el('span', { text: `${done}/${n} pronte` }))
    }
    syncRun()
  }

  /* ------------------------------------------------------------- controls */
  const effortCards = el('div', { class: 'effort-cards' })
  const paintEffort = () => {
    effortCards.replaceChildren(
      ...(['veloce', 'standard', 'profondo'] as Effort[]).map((k) => {
        const p = EFFORT[k]
        return el('button', {
          class: `effort-card${effort === k ? ' on' : ''}`,
          type: 'button',
          onclick: () => {
            effort = k
            minutes = p.minMinutes
            autoTime = true
            useVision = !!visionModel && effort !== 'veloce' ? true : useVision
            paintEffort()
            paintControls()
          },
        },
          el('b', { text: p.label }),
          el('span', { class: 'effort-hint', text: p.hint }),
          el('span', { class: 'effort-meta', text: `${p.maxImages ? `max ${p.maxImages} img` : 'tutte le img'} · batch ${p.batchSize} · ${p.maxTokens} token` }),
        )
      }),
    )
  }

  paintEffort()

  const timeRange = el('input', { class: 'field', type: 'range', min: '0', max: '25', step: '1', value: String(minutes) })
  const timeLabel = el('b', { text: `${minutes} min` })
  const autoChk = el('input', { type: 'checkbox' })
  autoChk.checked = autoTime
  const visionChk = el('input', { type: 'checkbox' })
  visionChk.checked = useVision
  visionChk.disabled = !visionModel
  const ocrChk = el('input', { type: 'checkbox' })
  ocrChk.checked = !useVision
  const transcriptChk = el('input', { type: 'checkbox' })
  transcriptChk.checked = keepTranscript
  const webChk = el('input', { type: 'checkbox' })
  webChk.checked = allowWeb
  const selText = el('select', { class: 'field' }, ...textOptions.map((m) => opt(m, textModel)))
  const selVision = el(
    'select',
    { class: 'field' },
    ...(visionOptions.length ? visionOptions.map((m) => opt(m, visionModel)) : [opt('nessuno (usa solo OCR)', '')]),
  )

  timeRange.addEventListener('input', () => {
    minutes = Number(timeRange.value)
    timeLabel.textContent = minutes ? `${minutes} min` : 'nessun minimo'
  })
  const paintControls = () => {
    autoChk.checked = autoTime
    visionChk.checked = useVision
    ocrChk.checked = !useVision
    timeLabel.textContent = minutes ? `${minutes} min` : 'nessun minimo'
    timeRange.value = String(minutes)
  }

  ocrChk.addEventListener('change', () => {
    useVision = !ocrChk.checked
    if (useVision && !visionModel) {
      useVision = false
      ocrChk.checked = true
      toast('Nessun modello con visione caricato: userò l’OCR locale (Tesseract, italiano, già dentro l’app)')
    }
    paintControls()
  })
  visionChk.addEventListener('change', () => {
    useVision = visionChk.checked
    ocrChk.checked = !useVision
  })
  autoChk.addEventListener('change', () => (autoTime = autoChk.checked))
  transcriptChk.addEventListener('change', () => (keepTranscript = transcriptChk.checked))
  webChk.addEventListener('change', () => (allowWeb = webChk.checked))

  const runBtn = el('button', { class: 'btn primary', type: 'button', text: 'Leggi e scrivi gli appunti', disabled: true }) as HTMLButtonElement
  const stopBtn = el('button', { class: 'btn ghost', type: 'button', text: 'Stop' })
  stopBtn.hidden = true
  runBtn.addEventListener('click', () => void run())
  stopBtn.addEventListener('click', () => {
    ac.abort()
    log('interrotto su tua richiesta')
  })
  const syncRun = () => {
    runBtn.disabled = !files.length || busy
    runBtn.textContent = files.length ? `Leggi ${files.length} immagini e scrivi gli appunti` : 'Leggi e scrivi gli appunti'
  }

  const controls = el('div', { class: 'scan-controls' },
    el('div', { class: 'scan-col' },
      el('h4', { class: 'scan-h4', text: 'Quanto deve pensarci' }),
      effortCards),
    el('div', { class: 'scan-col' },
      el('h4', { class: 'scan-h4', text: 'Tempo minimo' }),
      el('label', { class: 'field-row tight' }, timeRange, timeLabel),
      el('label', { class: 'inline-check' }, autoChk, el('span', { text: 'se finisce prima, usa il resto per “cosa serve ancora?” (smetti al 60% del budget)' }))),
    el('div', { class: 'scan-col' },
      el('h4', { class: 'scan-h4', text: 'Come legge le immagini' }),
      el('label', { class: 'inline-check' }, visionChk, el('span', { text: visionModel ? `legge i pixel con ${visionModel}` : 'nessun modello con visione (ollama pull qwen2.5vl:3b)' })),
      el('label', { class: 'inline-check' }, ocrChk, el('span', { text: 'in alternativa: OCR locale (Tesseract, gratis, offline)' })),
      el('label', { class: 'inline-check' }, transcriptChk, el('span', { text: 'fammi vedere/aggiustare la trascrizione' })),
      el('label', { class: 'inline-check' }, webChk, el('span', { class: 'web-note', text: 'alla fine: cerca su YouTube SOLO il link (testo degli appunti mai online)' }))),
    el('div', { class: 'scan-col' },
      el('h4', { class: 'scan-h4', text: 'Modelli' }),
      el('label', { class: 'field-row tight' }, el('span', { class: 'field-label', text: 'per scrivere' }), selText),
      el('label', { class: 'field-row tight' }, el('span', { class: 'field-label', text: 'per leggere' }), selVision)))

  /* --------------------------------------------------------------- output */
  const logBox = el('div', { class: 'scan-log' })
  const out = el('div', { class: 'scan-out' })
  const bar = el('div', { class: 'bar' }, el('div', { class: 'fill' }))
  const elapsed = el('span', { class: 'scan-elapsed' })
  const status = el('div', { class: 'scan-status' }, el('span', { text: 'fermo' }), elapsed)
  const resultActions = el('div', { class: 'row-btns wrap' })
  const body = el('div', { class: 'scan-modal' }, el('div', { class: 'scan-top' }, drop, picker, thumbs, clearBtn, controls, el('div', { class: 'row-btns' }, runBtn, stopBtn, status)), bar, logBox, out, resultActions)

  const timer = setInterval(() => {
    if (!busy) return
    elapsed.textContent = fmtElapsed(Date.now() - startedAt) + (minutes ? ` / min ${minutes}` : '')
  }, 500)
  let startedAt = 0

  function log(msg: string) {
    const line = el('div', { class: 'scan-line' }, el('span', { class: 'scan-t', text: new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }), el('span', { text: msg }))
    logBox.append(line)
    logBox.scrollTop = logBox.scrollHeight
  }

  const setBar = (done?: number, total?: number) => {
    const fill = bar.querySelector('.fill') as HTMLElement
    fill.style.width = done && total ? `${Math.min(100, Math.round((done / total) * 100))}%` : busy ? '35%' : '0%'
  }

  async function run() {
    if (busy || !files.length) return
    busy = true
    startedAt = Date.now()
    status.querySelector('span')!.textContent = 'lavora'
    runBtn.disabled = true
    stopBtn.hidden = false
    logBox.replaceChildren()
    out.replaceChildren()
    resultActions.replaceChildren()
    setBar()
    const modelForVision = selVision.value || visionModel
    const chosen = {
      images: prepared.filter(Boolean),
      effort,
      autoTime,
      minMinutes: minutes,
      useVision,
      keepTranscript,
      allowWeb,
      config: { ...getAiSettings(), model: selText.value || textModel, vision: modelForVision, useVision },
      model: selText.value || textModel,
      visionModel: modelForVision,
      signal: ac.signal,
      onProgress: (p: { msg: string; done?: number; total?: number; log?: string }) => {
        setBar(p.done, p.total)
        if (p.log) renderLive(p.log)
        else log(p.msg)
      },
    }
    try {
      const res = await runScan(chosen)
      lastResult = res
      setBar(1, 1)
      if (res.error) log(`⚠ ${res.error}`)
      log(`fatto in ${fmtElapsed(res.elapsedMs)} · ${res.imageCount} immagini · ${res.usedVision ? 'visione' : 'OCR'}${res.flashcards ? ' · flashcard' : ''}${res.extras ? ' · extra' : ''}`)
      renderResult(res)
    } catch (err) {
      log(`ERRORE: ${(err as Error).message}`)
      out.replaceChildren(el('p', { class: 'ai-err', text: `Qualcosa si è rotto: ${(err as Error).message}. Le immagini sono ancora lì: riprova, o passa da visione a OCR.` }))
    } finally {
      busy = false
      runBtn.disabled = false
      stopBtn.hidden = true
      status.querySelector('span')!.textContent = 'fermo'
      setBar()
    }
  }

  const live = el('div', { class: 'ai-msg ai' })
  function renderLive(md: string) {
    if (!live.isConnected) out.replaceChildren(live)
    live.innerHTML = mdToHtml(md)
    live.scrollIntoView({ block: 'nearest' })
  }

  function renderResult(res: ScanResult) {
    out.replaceChildren()
    const notes = el('div', { class: 'scan-notes' })
    notes.innerHTML = mdToHtml(res.notes || '_(nessun appunto prodotto)_')
    out.append(notes)
    if (res.extras?.trim()) {
      const ex = el('details', { class: 'scan-part' }, el('summary', { text: `In più, perché c’era tempo${minutes > 0 ? ` (${res.elapsedMs < minutes * 60000 ? `budget di ${minutes} min non finito` : 'budget finito'})` : ''}` }))
      const box = el('div', { class: 'ai-msg ai' })
      box.innerHTML = mdToHtml(res.extras)
      ex.append(box)
      out.append(ex)
    }
    if (res.flashcards?.trim()) {
      const fc = el('details', { class: 'scan-part', open: true }, el('summary', { text: 'Flashcard' }))
      fc.append(renderCards(res.flashcards))
      out.append(fc)
    }
    if (res.videos.length) {
      const vids = el('div', { class: 'scan-videos' })
      vids.append(el('h4', { class: 'scan-h4', text: 'Video da guardare (cerca tu: l’app apre solo il link)' }))
      for (const v of res.videos) {
        vids.append(el('a', { class: 'video-row', href: v.url, target: '_blank', rel: 'noopener noreferrer' },
          el('span', { class: 'play-ic', html: icons.play }), el('span', { text: v.title }), el('span', { class: 'video-host', text: 'youtube · ricerca' })))
      }
      out.append(vids)
    }
    if (res.transcript.length) {
      const tr = el('details', { class: 'scan-part' }, el('summary', { text: `Trascrizione delle ${res.transcript.length} immagini (aggiustala e ri-genera se serve)` }))
      const ta = el('textarea', { class: 'paste-area', spellcheck: 'false', text: res.transcript.map((t, i) => `=== ${i + 1} ===\n${t}`).join('\n\n') })
      const regen = el('button', { class: 'btn small', type: 'button', text: 'Rigenera gli appunti da questa trascrizione' }) as HTMLButtonElement
      regen.addEventListener('click', () => void regenerate(ta.value))
      tr.append(ta, el('div', { class: 'row-btns' }, regen))
      out.append(tr)
    }

    resultActions.replaceChildren(
      el('button', { class: 'btn primary', type: 'button', text: 'Crea appunto con tutto', onclick: () => void makeNote(res) }),
      el('button', { class: 'btn', type: 'button', text: 'Copia in fondo all’appunto aperto', onclick: () => void appendToOpenNote(res) }),
      el('button', {
        class: 'btn ghost',
        type: 'button',
        text: 'Copia come Markdown',
        onclick: async () => {
          const md = [res.notes, res.flashcards ? `## Flashcard\n${res.flashcards}` : '', res.extras ? `## In più\n${res.extras}` : '', res.videos.length ? `## Video\n${res.videos.map((v) => `- ${v.title}: ${v.url}`).join('\n')}` : ''].filter(Boolean).join('\n\n')
          await navigator.clipboard?.writeText?.(md)
          toast('Markdown negli appunti')
        },
      }),
    )
    void putScanRun({
      id: uid('r'),
      at: Date.now(),
      effort,
      imageCount: res.imageCount,
      usedVision: res.usedVision,
      minutes,
      notes: res.notes,
      flashcards: res.flashcards,
      extras: res.extras,
      transcript: res.transcript,
      videos: res.videos,
      ...(res.error ? { error: res.error } : {}),
    }).catch(() => undefined)
    void recentRuns()
  }

  /** Re-run only the writing step, on the text the user just corrected. */
  async function regenerate(text: string) {
    if (busy) return
    busy = true
    runBtn.disabled = true
    log('rigenero dagli appunti corretti…')
    const res = await chat({
      model: selText.value || textModel,
      text: `Questi appunti sono la trascrizione (corretta a mano) di pagine di studio. Scrivi appunti in Markdown, ordinati, SOLO da questo testo: niente nozioni esterne.\n\n${text.slice(0, 16000)}`,
      config: { ...getAiSettings(), model: selText.value || textModel },
      maxTokens: EFFORT[effort].maxTokens,
      temperature: 0.3,
      signal: ac.signal,
      onToken: (_c, full) => renderLive(full),
    })
    busy = false
    runBtn.disabled = false
    if (res.error) return log(`⚠ ${res.error}`)
    if (lastResult) lastResult = { ...lastResult, notes: res.text }
    renderResult({ ...(lastResult ?? { notes: res.text, transcript: [], flashcards: '', extras: '', queries: [], videos: [], usedVision: false, elapsedMs: 0, imageCount: 0 }), notes: res.text })
  }

  async function makeNote(res: ScanResult) {
    const subject = App.subjects[0]
    if (!subject) {
      toast('Crea prima un soggetto (⌘⇧N)')
      return
    }
    const topics = await listTopics(subject.id)
    const topic = topics[0] ?? (await createTopic(subject.id, 'Screenshot', '📸'))
    const blocks: Block[] = []
    const today = new Date().toLocaleDateString('it-IT', { day: '2-digit', month: 'short' })
    blocks.push({ id: uid('b'), type: 'text', content: `<i>${res.imageCount} immagini · ${res.usedVision ? 'lette dal modello' : 'OCR locale'} · ${EFFORT[effort].label} · ${today}</i>` })
    blocks.push(...blockify(res.notes))
    if (res.flashcards.trim()) {
      blocks.push({ id: uid('b'), type: 'h2', content: 'Flashcard' })
      let open: Block | null = null
      for (const line of res.flashcards.split('\n')) {
        const q = line.match(/^\s*DOMANDA\s*[:]\s*(.+)$/i)
        const a = line.match(/^\s*RISPOSTA\s*[:]\s*(.+)$/i)
        if (q) {
          if (open) { blocks.push(open); blocks.push({ id: uid('b'), type: 'text', content: '', indent: 1 }) }
          open = { id: uid('b'), type: 'toggle', content: q[1]!, collapsed: true }
        } else if (a && open) {
          blocks.push(open)
          blocks.push({ id: uid('b'), type: 'text', content: a[1]!, indent: 1 })
          open = null
        } else if (open && line.trim()) {
          open.content += ' ' + line.trim()
        }
      }
      if (open) blocks.push(open)
    }
    if (res.extras.trim()) {
      blocks.push({ id: uid('b'), type: 'h2', content: 'In più (perché c’era tempo)' })
      blocks.push(...blockify(res.extras, { plus: 1 }))
    }
    if (res.videos.length) {
      blocks.push({ id: uid('b'), type: 'h2', content: 'Video da guardare' })
      for (const v of res.videos) blocks.push({ id: uid('b'), type: 'link', url: v.url, label: v.title, kind: 'video', embed: false, addedAt: Date.now(), note: 'ricerca automatica su YouTube' })
    }
    const title = await guessTitle(res.notes)
    const note = await createNote(topic.id, title, blocks)
    App.emit()
    location.hash = routes.note(subject.id, topic.id, note.id)
    toast('Appunto creato, con le immagini dentro')
  }

  async function appendToOpenNote(res: ScanResult) {
    const noteId = App.route.view === 'note' ? App.route.noteId : ''
    if (!noteId) return toast('Apri un appunto, poi riprova')
    const note = await getNote(noteId)
    if (!note) return
    const blocks = [...note.blocks]
    blocks.push({ id: uid('b'), type: 'divider', content: '' })
    blocks.push(...blockify([res.notes, res.flashcards ? `## Flashcard\n${res.flashcards}` : '', res.extras ? `## In più\n${res.extras}` : ''].filter(Boolean).join('\n\n'), { plus: 1 }))
    await saveBlocks(noteId, blocks)
    App.emit()
    toast('Aggiunti all’appunto aperto')
  }

  async function guessTitle(notes: string) {
    const lines = notes.split('\n').map((l) => l.trim()).filter(Boolean)
    const first = lines.find((l) => l.startsWith('#')) ?? lines[0] ?? 'Appunti da screenshot'
    const fallback = first.replace(/[#*_>`]/g, '').replace(/^\d+[.)]\s*/, '').replace(/\s+/g, ' ').slice(0, 60)
    const cfg2 = getAiSettings()
    if (!cfg2.model) return fallback
    const res = await chat({
      model: selText.value || textModel || cfg2.model,
      text: ` Dai questi appunti, estrai UN titolo di 3-6 parole in italiano, senza punteggiatura finale, senza virgolette, senza spiegarlo.\n\n${notes.slice(0, 1800)}`,
      config: cfg2,
      maxTokens: 28,
      temperature: 0.1,
    })
    const t = (res.text || '').split('\n')[0]!.replace(/^[#*\s]+|[.*:]+$/g, '').trim()
    return sanitiseQuery(t ?? '') ? t.slice(0, 70) : fallback
  }

  const recent = el('div', { class: 'scan-recent' })
  async function recentRuns() {
    const runs = await listScanRuns(5)
    recent.replaceChildren()
    if (!runs.length) return
    recent.append(el('h4', { class: 'scan-h4', text: 'Scansioni recenti (testo salvato, immagini no)' }))
    for (const r of runs) {
      recent.append(
        el('div', { class: 'run-row' },
          el('button', {
            class: 'run-main',
            type: 'button',
            title: 'Riapri',
            onclick: () => renderResult({ notes: r.notes, transcript: r.transcript ?? [], flashcards: r.flashcards ?? '', extras: r.extras ?? '', queries: [], videos: r.videos ?? [], usedVision: !!r.usedVision, elapsedMs: 0, imageCount: r.imageCount }),
          }, el('b', { text: (r.notes.split('\n').find((l) => l.trim()) ?? 'appunti').replace(/[#*]/g, '').slice(0, 60) }), el('span', { class: 'run-meta', text: `${r.imageCount} img · ${r.effort} · ${new Date(r.at).toLocaleString('it-IT')}` })),
          el('button', {
            class: 'mini',
            type: 'button',
            title: 'Dimentica',
            html: icons.trash,
            onclick: async () => {
              await deleteScanRun(r.id)
              void recentRuns()
            },
          })),
      )
    }
  }
  void recentRuns()
  body.append(recent)

  const scrim = el('div', { class: 'scrim scan-scrim' }, el('div', { class: 'modal wide tall' },
    el('header', {},
      el('h2', { text: 'Screenshot → appunti' }),
      el('p', { class: 'sub', text: st.status === 'ok' ? `${st.models.length} modelli su ${cfg.endpoint}. Le immagini restano sul tuo PC; internet non viene toccato, se non per il link di YouTube che chiedi tu.` : `Nessun Ollama su ${cfg.endpoint}: puoi OCR-are comunque, ma per scrivere appunti serve un modello.` }),
      el('button', { class: 'mini close', type: 'button', title: 'Chiudi', html: icons.close, onclick: () => {
        if (busy) return toast('Aspetta che finisca, o premi Stop')
        scrim.remove()
        clearInterval(timer)
      } })),
    body))
  document.body.append(scrim)
  if (preselect?.length) void setFiles(preselect)
  if (st.status !== 'ok') log(`⚠ ${st.status === 'cors' ? 'Ollama blocca questa origine: OLLAMA_ORIGINS="*" ollama serve' : 'Ollama non risponde: ollama serve && ollama pull qwen2.5:3b'}`)
}

/**
 * Markdown -> real blocks. Deliberately small (no parser, line by line): the model's
 * output is short and predictable, and the user can fix anything that landed oddly in
 * the editor. `plus` bumps headings because appended notes sit under the note's title.
 */
/** @exported for tests: the markdown -> block mapping is the one thing users notice most. */
export function blockify(md: string, opts: { plus?: number } = {}): Block[] {
  const plus = opts.plus ?? 0
  const out: Block[] = []
  let code: string[] | null = null
  for (const raw of md.split('\n')) {
    const t = raw.trim()
    if (code) {
      if (/^```/.test(t)) {
        out.push({ id: uid('b'), type: 'code', content: code.join('\n') })
        code = null
      } else code.push(raw)
      continue
    }
    if (/^```/.test(t)) {
      code = []
      continue
    }
    if (!t) continue
    if (t === '---') {
      out.push({ id: uid('b'), type: 'divider', content: '' })
      continue
    }
    const h = t.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      const lvl = Math.min(3, h[1]!.length + plus)
      out.push({ id: uid('b'), type: `h${lvl}` as Block['type'], content: h[2]! })
      continue
    }
    const cal = t.match(/^>\s*\[![A-Za-z]+\]\s*(.*)$/)
    if (cal) {
      out.push({ id: uid('b'), type: 'callout', content: `💡 ${cal[1]!.trim() || 'Nota'}` })
      continue
    }
    if (t.startsWith('>')) {
      out.push({ id: uid('b'), type: 'quote', content: t.replace(/^>\s?/, '') })
      continue
    }
    const todo = t.match(/^[-*•]\s+\[[ xX]\]\s+(.*)$/)
    if (todo) {
      out.push({ id: uid('b'), type: 'todo', content: todo[1]!, checked: /\[[xX]\]/.test(t) })
      continue
    }
    const li = t.match(/^([-*•]|\d+[.)])\s+(.*)$/)
    if (li) {
      const numbered = /^\d/.test(li[1]!)
      out.push({ id: uid('b'), type: numbered ? 'numbered' : 'bulleted', content: li[2]! })
      continue
    }
    out.push({ id: uid('b'), type: 'text', content: t })
  }
  if (code && code.length) out.push({ id: uid('b'), type: 'code', content: code.join('\n') })
  return out
}

function renderCards(raw: string) {
  const box = el('div', { class: 'cards' })
  const pairs: [string, string][] = []
  let pending = ''
  for (const line of raw.split('\n')) {
    const q = line.match(/^\s*DOMANDA\s*[:]\s*(.+)$/i)?.[1]?.trim()
    const a = line.match(/^\s*RISPOSTA\s*[:]\s*(.+)$/i)?.[1]?.trim()
    if (q) pending = q
    else if (a && pending) {
      pairs.push([pending, a])
      pending = ''
    }
  }
  if (!pairs.length) {
    const pre = el('pre', { class: 'cards-raw', text: raw })
    return pre
  }
  for (const [q, a] of pairs) {
    box.append(el('div', { class: 'card-fc' }, el('b', { text: q }), el('span', { text: a })))
  }
  return box
}

function opt(value: string, selected: string) {
  const o = document.createElement('option')
  o.value = value
  o.textContent = value
  if (value === selected) o.selected = true
  return o
}

/** The reader's "study ahead" strip: digests make the next answers faster. */
export function studyStrip(bookId: string, page: number, onDone: () => void) {
  const wrap = el('div', { class: 'study-strip' })
  const refresh = async () => {
    const [d, n] = await Promise.all([digestFor(bookId, page), digestCount(bookId)])
    const st = studyState()
    const book = await getBook(bookId)
    wrap.replaceChildren()
    wrap.append(
      el('div', { class: 'study-head' },
        el('span', { class: 'study-label', text: 'L’AI ha già studiato' }),
        el('b', { text: `${n}/${book?.pageCount ?? '?'} pagine` }),
        st.running ? el('span', { class: 'study-run', text: `sta leggendo p. ${st.current ?? '…'} (${st.done}/${st.total})` }) : null,
        st.paused && st.reason ? el('span', { class: 'study-paused', text: `in pausa: ${st.reason}` }) : null),
    )
    if (d?.md.trim()) {
      const det = el('details', { class: 'study-digest', open: !st.running })
      det.append(el('summary', { text: `scheda di p. ${page} · ${new Date(d.at).toLocaleDateString('it-IT')}` }))
      const box = el('div', { class: 'ai-msg ai' })
      box.innerHTML = mdToHtml(d.md)
      det.append(box)
      det.append(el('div', { class: 'row-btns' },
        el('button', { class: 'link-btn', type: 'button', text: 'ri-studia questa pagina', onclick: () => { if (book) void studyBook(book, page, 1).then(onDone) } }),
        el('button', { class: 'link-btn', type: 'button', text: 'buttala via', onclick: async () => { await dropDigests(bookId, page); await refresh() } })))
      wrap.append(det)
    } else {
      wrap.append(el('p', { class: 'side-hint', text: 'Questa pagina non è ancora nelle sue schede. Studiarla ora vuol dire risposte più rapide e meno invenzioni dopo.' }))
    }
    wrap.append(el('div', { class: 'row-btns' },
      el('button', { class: 'btn small', type: 'button', text: st.running ? 'ferma' : 'estudia le prossime 12 pagine', onclick: () => {
        if (!book) return
        if (st.running) return stopStudy()
        void studyBook(book, page, 12).then(onDone)
      } }),
      ...(n ? [el('button', { class: 'btn small ghost', type: 'button', text: 'pulisci schede', onclick: async () => { await dropDigests(bookId); await refresh() } })] : [])))
  }
  void refresh()
  // unsubscribe when the reader closes; MutationObserver is not in every environment
  const off = onStudyChange(() => { void refresh() })
  const MO = (globalThis as unknown as { MutationObserver?: typeof MutationObserver }).MutationObserver
  if (MO) {
    const obs = new MO(() => { if (!wrap.isConnected) { obs.disconnect(); off() } })
    obs.observe(document.body, { childList: true, subtree: true })
  }
  return wrap
}
