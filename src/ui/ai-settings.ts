import { checkOllama, DEFAULT_AI, getAiSettings, setAiSettings, type AiConfig } from '../core/ai'
import { el } from './dom'
import { toast } from './dom'
import { App } from './state'

/**
 * The AI dialog, outside the reader too (⌘K → "AI locale").
 * It only ever talks to Ollama on this machine: no key, no cloud, no cost.
 */
export async function aiSettingsModal(afterSave?: () => void) {
  document.querySelector('.scrim.ai-scrim')?.remove()
  const cfg = getAiSettings()
  const st = await checkOllama(cfg.endpoint)
  const models = st.status === 'ok' ? st.models : []
  const vision = st.status === 'ok' ? st.visionModels : []
  const selText = el('select', { class: 'field' }, ...models.map((m) => opt(m, cfg.model)))
  const selVision = el('select', { class: 'field' }, ...[...new Set([...vision, 'nessuno (solo testo)'])].map((m) => opt(m, cfg.vision || 'nessuno (solo testo)')))
  const endpoint = el('input', { class: 'field', 'data-field': 'endpoint', value: cfg.endpoint })
  const ctx = el('input', { class: 'field', type: 'range', min: '3000', max: '30000', step: '1000', value: String(cfg.contextChars) })
  const ctxLabel = el('b', { text: String(cfg.contextChars) })
  ctx.addEventListener('input', () => (ctxLabel.textContent = ctx.value))
  const ctxRow = el('div', { class: 'field-inline' }, ctxLabel, ' ', ctx)
  const lang = el('select', { class: 'field', 'data-field': 'language' }, opt('italiano', cfg.language), opt('english', cfg.language))
  const visionOn = el('input', { type: 'checkbox', 'data-field': 'vision', ...(cfg.useVision ? { checked: true } : {}) })
  const body = el(
    'div',
    { class: 'ai-settings' },
    el('p', { class: 'lede', text: st.status === 'ok' ? `Ollama raggiungibile su ${cfg.endpoint}${st.version ? ` (v${st.version})` : ''}: ${models.length} modelli caricati.` : `Ollama non raggiungibile su ${cfg.endpoint}. Senza modello, l’AI fa solo ricerca nel libro e citazioni: già utile.` }),
    st.status === 'cors'
      ? el('p', { class: 'ai-err', text: 'Ollama gira, ma ha rifiutato la richiesta perché l’indirizzo di questa app non è in lista. Avvialo con: OLLAMA_ORIGINS="*" ollama serve (oppure apri l’app da http://localhost:5173).' })
      : null,
    el('div', { class: 'setup-steps' },
      el('p', { class: 'setup-title', text: 'Una volta sola, sul tuo PC — poi non serve più niente' }),
      el('ol', {},
        el('li', { html: 'Installa Ollama (nessun account): su Windows <code>winget install Ollama.Ollama</code>, su Mac <code>brew install ollama</code>.' }),
        el('li', { html: 'Scarica un modello piccolo, buono anche su 8 GB: <code>ollama pull qwen2.5:3b</code> (~2,6 GB).' }),
        el('li', { html: 'Se vuoi che legga figure e grafici: <code>ollama pull qwen2.5vl:3b</code> e attiva “leggi anche l’immagine” qui sotto.' }),
        el('li', { html: 'Tienilo acceso: <code>ollama serve</code> (su Windows e Mac parte da solo all’avvio).' }),
      ),
      el('p', { class: 'setup-note', text: 'Nulla esce dal tuo computer: le richieste vanno solo a 127.0.0.1, senza chiavi né conti. Su un PC vecchio una pagina richiede 20–60 s: è normale.' }),
    ),
    models.length ? field('Modello per il testo', selText) : null,
    field('Modello con visione', selVision),
    field('Indirizzo di Ollama', endpoint),
    field('Caratteri di libro mandati al modello', ctxRow),
    field('Lingua delle risposte', lang),
    field('Leggi anche l’immagine della pagina', el('span', { class: 'inline-check' }, visionOn)),
  )
  const scrim = el('div', { class: 'scrim ai-scrim' }, el('div', { class: 'modal wide' },
    el('header', {}, el('h2', { text: 'AI locale (Ollama)' }), el('p', { class: 'sub', text: 'Nessuna API a pagamento, nessuna chiave: gira sul tuo PC.' })),
    body,
    el('footer', {}, el('button', { class: 'btn ghost', type: 'button', text: 'Annulla', onclick: () => scrim.remove() }),
      el('button', { class: 'btn primary', type: 'button', text: 'Salva', onclick: () => void save() }))))
  async function save() {
    const v = selVision.value === 'nessuno (solo testo)' ? '' : selVision.value
    await setAiSettings({
      endpoint: endpoint.value.trim() || DEFAULT_AI.endpoint,
      model: selText.value || cfg.model,
      vision: v,
      useVision: visionOn.checked && !!v,
      contextChars: Number(ctx.value) || DEFAULT_AI.contextChars,
      language: lang.value as AiConfig['language'],
    })
    scrim.remove()
    toast('Impostazioni AI salvate')
    App.emit()
    void afterSave?.()
  }
  document.body.append(scrim)
  scrim.addEventListener('pointerdown', (e) => {
    if (e.target === scrim) scrim.remove()
  })
}


function opt(value: string, selected: string) {
  const o = document.createElement('option')
  o.value = value
  o.textContent = value
  if (value === selected) o.selected = true
  return o
}
function field(label: string, input: HTMLElement) {
  return el('label', { class: 'field-row' }, el('span', { class: 'field-label', text: label }), input)
}
