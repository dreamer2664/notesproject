import type { InkStroke, InkTool } from './types'

/**
 * The pen layer. Deliberately not a canvas: ink is stored as pressure-width
 * polylines in normalised 0..1 space, so it survives resize, zoom, print and
 * Markdown export, and it stays tiny enough to live inside a note block.
 */

export const VB = 1000 // viewBox is always 0 0 1000 1000; the element scales the drawing

export const PALETTE = [
  { name: 'Inchiostro', c: '#1d1d1f' },
  { name: 'Blu penna', c: '#0a57d6' },
  { name: 'Rosso correzione', c: '#d62828' },
  { name: 'Verde', c: '#1f8a4c' },
  { name: 'Evidenziatore', c: '#ffd43b' },
] as const

export const WIDTHS: Record<InkTool, number> = { pen: 3.1, highlight: 14, eraser: 18 }

const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v))

/** points (normalised) -> the compact number array we store */
export function packPoints(points: { x: number; y: number; p: number }[]): number[] {
  const out: number[] = []
  for (const pt of points) out.push(Math.round(clamp(pt.x) * 1000) / 1000, Math.round(clamp(pt.y) * 1000) / 1000, Math.round(clamp(pt.p) * 100) / 100)
  return out
}

export function unpackPoints(d: number[]): { x: number; y: number; p: number }[] {
  const pts: { x: number; y: number; p: number }[] = []
  for (let i = 0; i + 2 < d.length; i += 3) pts.push({ x: d[i]!, y: d[i + 1]!, p: d[i + 2] ?? 0.5 })
  return pts
}

/** A path per ~2 points, so the width can vary along the stroke (pen feel). */
export function strokePaths(stroke: InkStroke, widthScale = 1): { d: string; w: number; op: number }[] {
  const pts = unpackPoints(stroke.d)
  if (pts.length < 2) {
    const p = pts[0] ?? { x: 0.5, y: 0.5, p: 0.5 }
    const r = (stroke.w * (0.5 + p.p)) / 2
    return [{ d: `M ${p.x * VB} ${p.y * VB} m ${-r} 0 a ${r} ${r} 0 1 0 ${r * 2} 0 a ${r} ${r} 0 1 0 ${-r * 2} 0`, w: 0.01, op: 1 }]
  }
  const out: { d: string; w: number; op: number }[] = []
  const step = stroke.t === 'highlight' ? Math.max(3, Math.floor(pts.length / 10)) : 2
  for (let i = 0; i + 1 < pts.length; i += step) {
    const slice = pts.slice(Math.max(0, i - 1), Math.min(pts.length, i + step + 2))
    const midPressure = slice.reduce((a, p) => a + p.p, 0) / slice.length
    const w = stroke.w * (0.42 + midPressure * 1.15) * widthScale
    let d = `M ${slice[0]!.x * VB} ${slice[0]!.y * VB}`
    for (let k = 1; k < slice.length - 1; k++) {
      const a = slice[k]!
      const b = slice[k + 1]!
      d += ` Q ${a.x * VB} ${a.y * VB} ${((a.x + b.x) / 2) * VB} ${((a.y + b.y) / 2) * VB}`
    }
    const last = slice[slice.length - 1]!
    d += ` L ${last.x * VB} ${last.y * VB}`
    out.push({ d, w, op: stroke.t === 'highlight' ? 0.32 : 1 })
  }
  return out
}

export function renderInk(container: Element, strokes: InkStroke[], widthScale = 1) {
  for (const s of strokes) {
    for (const piece of strokePaths(s, widthScale)) {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      path.setAttribute('d', piece.d)
      path.setAttribute('stroke', s.c)
      path.setAttribute('stroke-width', String(Math.max(0.4, piece.w)))
      path.setAttribute('stroke-linecap', s.t === 'highlight' ? 'butt' : 'round')
      path.setAttribute('stroke-linejoin', 'round')
      path.setAttribute('fill', 'none')
      path.setAttribute('opacity', String(piece.op))
      if (s.t === 'highlight') path.setAttribute('style', 'mix-blend-mode:multiply')
      path.dataset.tool = s.t
      container.append(path)
    }
  }
}

const dist2 = (a: { x: number; y: number }, b: { x: number; y: number }) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2

/** Eraser: drop strokes with a sample near the pointer. Vector erasing beats masking. */
export function eraseAt(strokes: InkStroke[], x: number, y: number, radius = 0.022): InkStroke[] {
  const r2 = radius * radius
  return strokes.filter((s) => !unpackPoints(s.d).some((p) => dist2(p, { x, y }) < r2 * (s.t === 'highlight' ? 3 : 1)))
}

export interface InkApi {
  getStrokes: () => InkStroke[]
  setStrokes: (s: InkStroke[]) => void
  undo: () => void
  clear: () => void
  setTool: (t: InkTool) => void
  setColor: (c: string) => void
  setSize: (n: number) => void
  setEnabled: (on: boolean) => void
  isEmpty: () => boolean
  destroy: () => void
  svg: SVGSVGElement
}

interface InkOptions {
  strokes?: InkStroke[]
  enabled?: boolean
  onChange?: (strokes: InkStroke[]) => void
  /** hide the floating toolbar (the editor draws its own) */
  noToolbar?: boolean
}

/**
 * Mounts the drawing surface inside `host` (which must be position:relative and
 * hold the page/figure). Returns the imperative API the toolbar buttons call.
 */
export function mountInk(host: HTMLElement, opts: InkOptions = {}): InkApi {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', `0 0 ${VB} ${VB}`)
  svg.setAttribute('preserveAspectRatio', 'none')
  svg.classList.add('ink-svg')
  const layer = document.createElementNS('http://www.w3.org/2000/svg', 'g')
  svg.append(layer)
  host.append(svg)

  let strokes: InkStroke[] = (opts.strokes ?? []).map((s) => ({ ...s, d: [...s.d] }))
  let tool: InkTool = 'pen'
  let color: string = PALETTE[0]!.c
  let size = 1
  let enabled = opts.enabled ?? false
  let current: { pts: { x: number; y: number; p: number }[]; node: SVGGElement } | null = null
  let erasing = false
  const undoStack: InkStroke[][] = []

  const paint = () => {
    layer.replaceChildren()
    renderInk(layer, strokes)
    svg.classList.toggle('has-ink', strokes.length > 0)
  }
  const commit = (next: InkStroke[]) => {
    if (next !== strokes) {
      undoStack.push(strokes)
      if (undoStack.length > 40) undoStack.shift()
      strokes = next
    }
    paint()
    opts.onChange?.(strokes.map((s) => ({ ...s, d: [...s.d] })))
  }

  const rel = (e: PointerEvent) => {
    const r = svg.getBoundingClientRect()
    return { x: (e.clientX - r.left) / Math.max(1, r.width), y: (e.clientY - r.top) / Math.max(1, r.height) }
  }

  const onDown = (e: PointerEvent) => {
    if (!enabled) return
    // Palm rejection: with a pen around, fingers never draw. Tap the eraser
    // button (or hold Space) to use a finger deliberately.
    if (e.pointerType === 'touch' && tool !== 'eraser' && wantsPenOnly() && host.dataset.touchMode !== 'on') return
    e.preventDefault()
    svg.setPointerCapture?.(e.pointerId)
    const pt = rel(e)
    if (tool === 'eraser') {
      erasing = true
      commit(eraseAt(strokes, pt.x, pt.y))
      return
    }
    current = { pts: [{ ...pt, p: pressure(e) }], node: document.createElementNS('http://www.w3.org/2000/svg', 'g') }
    svg.append(current.node)
  }

  const onMove = (e: PointerEvent) => {
    if (!enabled) return
    const pt = rel(e)
    if (erasing) {
      commit(eraseAt(strokes, pt.x, pt.y))
      return
    }
    if (!current) return
    e.preventDefault()
    const samples = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : []
    const points = samples.length ? samples.map((s) => ({ ...rel(s), p: pressure(s) })) : [{ ...pt, p: pressure(e) }]
    for (const p of points) {
      const prev = current.pts[current.pts.length - 1]!
      if (dist2(prev, p) < 0.000008 && Math.abs(prev.p - p.p) < 0.05) continue
      current.pts.push(p)
    }
    redrawCurrent()
  }

  const redrawCurrent = () => {
    if (!current) return
    current.node.replaceChildren()
    renderInk(current.node, [{ t: tool, c: color, w: WIDTHS[tool]! * size, d: packPoints(current.pts) }])
  }

  const onUp = (e: PointerEvent) => {
    if (!enabled) return
    svg.releasePointerCapture?.(e.pointerId)
    if (erasing) {
      erasing = false
      return
    }
    if (!current) return
    const pts = current.pts
    current.node.remove()
    const node = current.node
    current = null
    if (pts.length < 2) {
      // a tap is still a dot: people use it to underline a single word
      pts.push({ ...pts[0]!, x: pts[0]!.x + 0.0015, y: pts[0]!.y + 0.0015 })
    }
    node.remove()
    commit([...strokes, { t: tool, c: color, w: WIDTHS[tool]! * size, d: packPoints(pts) }])
  }

  const pressure = (e: PointerEvent) => {
    if (e.pointerType === 'pen' && typeof e.pressure === 'number' && e.pressure > 0) return clamp(e.pressure, 0.05, 1)
    return 0.55
  }

  svg.addEventListener('pointerdown', onDown)
  svg.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  svg.addEventListener('pointercancel', () => {
    current?.node.remove()
    current = null
    erasing = false
  })
  svg.addEventListener('contextmenu', (e) => e.preventDefault())
  // space held = temporary eraser, like every drawing app
  const spaceDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && enabled && !isTyping(e.target)) {
      e.preventDefault()
      tool = 'eraser'
      paintToolbar()
    }
  }
  const spaceUp = (e: KeyboardEvent) => {
    if (e.code === 'Space' && tool === 'eraser') {
      tool = 'pen'
      paintToolbar()
    }
  }
  window.addEventListener('keydown', spaceDown)
  window.addEventListener('keyup', spaceUp)

  /* ------------------------------------------------------------- toolbar */
  const bar = document.createElement('div')
  bar.className = 'ink-bar'
  const btn = (html: string, title: string, onclick: () => void, cls = '') => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = `ink-btn ${cls}`
    b.title = title
    b.innerHTML = html
    b.addEventListener('click', onclick)
    return b
  }
  const penBtn = btn('<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 20l3.5-.8L20 6.7a2.1 2.1 0 0 0-3-3L4.5 16.2 4 20z"/></svg>', 'Penna', () => setTool('pen'))
  const hlBtn = btn('<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 19h6M7 16l8.5-8.5a2 2 0 1 1 2.8 2.8L10 18.5"/></svg>', 'Evidenziatore', () => setTool('highlight'))
  const erBtn = btn('<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M8 19H5l-1.5-1.5a1.6 1.6 0 0 1 0-2.3L13 5.7a1.6 1.6 0 0 1 2.3 0l4.5 4.5a1.6 1.6 0 0 1 0 2.3L12 20H8z"/></svg>', 'Gomma (o tieni Spazio)', () => setTool('eraser'))
  const undoBtn = btn('<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 9h9a5 5 0 1 1 0 10H8"/><path d="M4 9l4-4M4 9l4 4"/></svg>', 'Annulla tratto', () => {
    const prev = undoStack.pop()
    if (prev) {
      strokes = prev
      paint()
      opts.onChange?.(strokes.map((s) => ({ ...s, d: [...s.d] })))
    }
  })
  const clearBtn = btn('<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M5 7h14M10 7V5h4v2M7 7l.8 12a1.6 1.6 0 0 0 1.6 1.5h5.2A1.6 1.6 0 0 0 16.2 19L17 7"/></svg>', 'Tutto via', () => commit([]))
  const colors = document.createElement('div')
  colors.className = 'ink-colors'
  for (const c of PALETTE) {
    const sw = document.createElement('button')
    sw.type = 'button'
    sw.className = 'ink-sw'
    sw.title = c.name
    sw.style.setProperty('--sw', c.c)
    sw.addEventListener('click', () => {
      setColor(c.c)
      if (c.c === '#ffd43b') setTool('highlight')
    })
    colors.append(sw)
  }
  bar.append(penBtn, hlBtn, erBtn, colors, undoBtn, clearBtn)
  if (!opts.noToolbar) host.append(bar)

  function setTool(t: InkTool) {
    tool = t
    enabled = true
    svg.classList.add('drawing')
    paintToolbar()
  }
  function setColor(c: string) {
    color = c
    for (const [i, p] of [...PALETTE.entries()]) sw(i, p.c === c)
  }
  const sw = (i: number, on: boolean) => colors.children[i]?.classList.toggle('on', on)
  function paintToolbar() {
    penBtn.classList.toggle('on', tool === 'pen')
    hlBtn.classList.toggle('on', tool === 'highlight')
    erBtn.classList.toggle('on', tool === 'eraser')
    svg.classList.toggle('eraser', tool === 'eraser')
  }

  paint()
  paintToolbar()
  setSwatches()
  function setSwatches() {
    PALETTE.forEach((p, i) => sw(i, p.c === color))
  }

  return {
    getStrokes: () => strokes.map((s) => ({ ...s, d: [...s.d] })),
    setStrokes: (s) => {
      strokes = s.map((x) => ({ ...x, d: [...x.d] }))
      paint()
    },
    undo: () => undoBtn.click(),
    clear: () => commit([]),
    setTool,
    setColor: (c) => {
      color = c
      setSwatches()
    },
    setSize: (n) => {
      size = clamp(n, 0.4, 4)
    },
    setEnabled: (on) => {
      enabled = on
      svg.classList.toggle('drawing', on)
      if (!on) host.classList.remove('ink-on')
      else host.classList.add('ink-on')
    },
    isEmpty: () => strokes.length === 0,
    destroy() {
      svg.remove()
      bar.remove()
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', spaceDown)
      window.removeEventListener('keyup', spaceUp)
    },
    svg,
  }
}

const isTyping = (t: EventTarget | null) => !!(t as HTMLElement)?.closest?.('input, textarea, [contenteditable="true"]')

let penOnlyCache: boolean | null = null
/** If a pen is paired, ignore finger input on the page layer. Cheap and effective. */
function wantsPenOnly() {
  if (penOnlyCache !== null) return penOnlyCache
  penOnlyCache = true
  void (async () => {
    try {
      const caps = await (navigator as unknown as { mediaDevices?: { enumerateDevices?: () => Promise<{ kind: string; label: string }[]> } }).mediaDevices?.enumerateDevices?.()
      const had = !!caps?.length
      if (had) penOnlyCache = caps.some((d) => /pen|stylus|touch ?screen/i.test(d.label))
    } catch {
      /* keep the default */
    }
  })()
  return penOnlyCache
}

/** Inline SVG string, for the Markdown archive. */
export function inkToSvg(strokes: InkStroke[], w = 760, h = 460) {
  if (!strokes.length) return ''
  const parts: string[] = []
  for (const s of strokes) {
    for (const piece of strokePaths(s, 1)) {
      parts.push(
        `<path d="${piece.d}" stroke="${s.c}" stroke-width="${Math.max(0.4, piece.w)}" stroke-linecap="${s.t === 'highlight' ? 'butt' : 'round'}" fill="none" opacity="${piece.op}"${s.t === 'highlight' ? ' style="mix-blend-mode:multiply"' : ''}/>`,
      )
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VB} ${VB}" preserveAspectRatio="none" width="${w}" height="${h}">${parts.join('')}</svg>`
}
