import type { Block, Note } from '../core/types'
import { uid, safeUrl, debounce, sanitizeHtml, stripToInline, escapeHtml } from '../core/util'
import { defaultLabelForUrl, fileToImageSrc, linkInfo } from '../core/fs'
import { icons } from '../ui/icons'
import { modal, toast } from '../ui/dom'

/* ------------------------------------------------------------------ menus */

interface SlashItem {
  key: string
  label: string
  hint: string
  glyph: string
  kind: 'turn' | 'insert'
  type: Block['type']
  needs?: 'url' | 'file'
  search: string
}

const SLASH: SlashItem[] = [
  { key: 'text', label: 'Text', hint: 'Plain paragraph', glyph: 'Aa', kind: 'turn', type: 'text', search: 'text plain paragraph body' },
  { key: 'h1', label: 'Heading 1', hint: 'Big section title', glyph: 'H1', kind: 'turn', type: 'h1', search: 'h1 heading title big' },
  { key: 'h2', label: 'Heading 2', hint: 'Medium title', glyph: 'H2', kind: 'turn', type: 'h2', search: 'h2 heading title' },
  { key: 'h3', label: 'Heading 3', hint: 'Small title', glyph: 'H3', kind: 'turn', type: 'h3', search: 'h3 heading title small' },
  { key: 'bulleted', label: 'Bulleted list', hint: 'A bullet point', glyph: '•', kind: 'turn', type: 'bulleted', search: 'bullet unordered list' },
  { key: 'numbered', label: 'Numbered list', hint: '1. ordered step', glyph: '1.', kind: 'turn', type: 'numbered', search: 'number ordered list' },
  { key: 'todo', label: 'To-do', hint: 'Checkbox you can tick', glyph: '☑', kind: 'turn', type: 'todo', search: 'todo check task checkbox' },
  { key: 'toggle', label: 'Toggle', hint: 'Collapsible, hides what follows', glyph: '▸', kind: 'turn', type: 'toggle', search: 'toggle collapsible fold hide' },
  { key: 'quote', label: 'Quote', hint: 'Someone else\'s words', glyph: '❝', kind: 'turn', type: 'quote', search: 'quote blockquote citation' },
  { key: 'callout', label: 'Callout', hint: 'A note worth noticing', glyph: '💡', kind: 'turn', type: 'callout', search: 'callout info warning highlight note' },
  { key: 'code', label: 'Code', hint: 'Monospaced, no auto-format', glyph: '</>', kind: 'turn', type: 'code', search: 'code snippet mono' },
  { key: 'divider', label: 'Divider', hint: 'A thin line', glyph: '—', kind: 'insert', type: 'divider', search: 'divider line hr separator' },
  { key: 'image', label: 'Image', hint: 'Paste, drop or pick a file', glyph: '🖼', kind: 'insert', type: 'image', needs: 'file', search: 'image picture screenshot photo' },
  { key: 'link', label: 'Link to video / article', hint: 'Card with type, note and player', glyph: '🔗', kind: 'insert', type: 'link', needs: 'url', search: 'link url video article reference embed youtube' },
  { key: 'video', label: 'Video link', hint: 'Same, tagged as video', glyph: '▶', kind: 'insert', type: 'link', needs: 'url', search: 'video youtube lecture film' },
]

/* ----------------------------------------------------------------- caret */

function caretOffset(root: HTMLElement): number | null {
  const sel = document.getSelection()
  if (!sel || !sel.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!root.contains(range.startContainer)) return null
  const pre = range.cloneRange()
  pre.selectNodeContents(root)
  pre.setEnd(range.startContainer, range.startOffset)
  return pre.toString().length
}

function setCaret(root: HTMLElement, offset: number | null) {
  const sel = document.getSelection()
  if (!sel) return
  if (offset === null) {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
    return
  }
  let remaining = offset
  const walk = (node: Node): boolean => {
    if (node.nodeType === Node.TEXT_NODE) {
      const len = node.textContent?.length ?? 0
      if (remaining <= len) {
        const range = document.createRange()
        range.setStart(node, remaining)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
        return true
      }
      remaining -= len
      return false
    }
    for (const child of Array.from(node.childNodes)) if (walk(child)) return true
    return false
  }
  if (!walk(root)) {
    const range = document.createRange()
    range.selectNodeContents(root)
    range.collapse(false)
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

/* ---------------------------------------------------------------- editor */

export interface EditorHandle {
  flush: () => Promise<void>
  /** Replace the block list from the outside (e.g. after a link is added from the panel). */
  replaceBlocks: (blocks: Block[]) => void
  destroy: () => void
}

export function mountEditor(host: HTMLElement, note: Note, onSave: (blocks: Block[]) => void): EditorHandle {
  let blocks: Block[] = note.blocks.map((b) => ({ ...b }))
  let dirty = false
  let programmatic = false
  const byId = new Map<string, Block>()
  const rows = new Map<string, HTMLElement>()
  let slashOpen: { el: HTMLElement; items: SlashItem[]; active: number; row: HTMLElement; mode: 'turn' | 'insert' } | null = null
  let dragRow: HTMLElement | null = null

  /* -------------------------------------------------------------- build row */

  function rowEl(b: Block): HTMLElement {
    byId.set(b.id, b)
    const row = el2('div', {
      class: 'brow',
      dataset: { id: b.id, type: b.type, indent: String(b.indent ?? 0) },
    })
    const gutter = el2('div', { class: 'gutter' })
    const add = el2('button', {
      class: 'g-btn',
      type: 'button',
      title: 'Insert block below',
      html: icons.plus,
      onclick: (e: Event) => {
        e.stopPropagation()
        const fresh = newBlock('text')
        insertAfter(b.id, fresh)
        openSlash(fresh.id, 'insert', true)
      },
    })
    const handle = el2('button', {
      class: 'g-btn grip',
      type: 'button',
      title: 'Drag to move · click for options',
      html: icons.grip,
      draggable: 'true',
    })
    handle.addEventListener('click', () => rowMenu(b.id, handle))
    handle.addEventListener('dragstart', (e: DragEvent) => {
      dragRow = row
      row.classList.add('dragging')
      e.dataTransfer?.setData('text/plain', b.id)
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
    })
    handle.addEventListener('dragend', () => {
      dragRow = null
      row.classList.remove('dragging')
      clearDropLines()
    })
    gutter.append(add, handle)
    row.append(gutter, el2('div', { class: 'bcontent' }, bodyFor(b)))

    row.addEventListener('dragover', (e: DragEvent) => {
      if (!dragRow || dragRow === row) return
      e.preventDefault()
      const rect = row.getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      row.classList.toggle('drop-after', after)
      row.classList.toggle('drop-before', !after)
    })
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'))
    row.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault()
      if (!dragRow || dragRow === row) return
      const rect = row.getBoundingClientRect()
      const after = e.clientY > rect.top + rect.height / 2
      const id = dragRow.getAttribute('data-id')!
      const from = blocks.findIndex((x) => x.id === id)
      const [moved] = blocks.splice(from, 1)
      let to = blocks.findIndex((x) => x.id === b.id)
      if (after) to += 1
      blocks.splice(to, 0, moved!)
      clearDropLines()
      commit()
    })
    return row
  }

  function clearDropLines() {
    host.querySelectorAll('.drop-before, .drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after'))
  }

  function bodyFor(b: Block): HTMLElement {
    if (b.type === 'divider') return el2('div', { class: 'b-divider' })
    if (b.type === 'image') return imageBody(b)
    if (b.type === 'link') return linkBody(b)
    if (b.type === 'code') {
      const pre = el2('pre', { class: 'b-code', contenteditable: 'true', spellcheck: 'false' })
      pre.textContent = b.content ?? ''
      return el2('div', { class: 'codewrap' }, pre, el2('button', {
        class: 'lang-btn',
        type: 'button',
        text: (b.language ?? 'plain').toUpperCase(),
        onclick: () => {
          const langs = ['plain', 'js', 'ts', 'py', 'sh', 'sql', 'json']
          b.language = langs[(langs.indexOf(b.language ?? 'plain') + 1) % langs.length]
          commit()
        },
      }))
    }
    const tag = b.type === 'todo' ? 'div' : b.type === 'h1' ? 'div' : 'div'
    const c = el2(tag, { class: 'b-text', contenteditable: 'true', spellcheck: 'true' })
    c.innerHTML = sanitizeHtml(b.content ?? '')
    if (!(b.content ?? '').trim()) c.setAttribute('data-empty', '1')
    if (b.type === 'todo') {
      return el2(
        'div',
        { class: 'todowrap' },
        el2('input', {
          class: 'b-check',
          type: 'checkbox',
          ...(b.checked ? { checked: true } : {}),
          onchange: (e: Event) => {
            b.checked = (e.target as HTMLInputElement).checked
            commit()
          },
        }),
        c,
      )
    }
    if (b.type === 'toggle') {
      const caret = el2('button', { class: 'b-caret', type: 'button', html: icons.chevron, title: 'Collapse / expand (Alt+Enter)' })
      caret.addEventListener('click', () => {
        b.collapsed = !b.collapsed
        commit()
      })
      return el2('div', { class: 'togglewrap' }, caret, c)
    }
    return c
  }

  /* --------------------------------------------------------- image + link */

  function imageBody(b: Block): HTMLElement {
    const wrap = el2('figure', { class: 'b-image' })
    if (b.src) {
      wrap.append(
        el2('img', { src: b.src, alt: b.alt ?? '', loading: 'lazy' }),
        el2('div', { class: 'image-tools' }, el2('button', {
          class: 'mini',
          type: 'button',
          text: 'Replace',
          onclick: () => pickImage(b, wrap),
        })),
      )
    } else {
      wrap.append(
        el2('button', {
          class: 'image-empty',
          type: 'button',
          html: `${icons.image}<span>Drop, paste or choose an image</span>`,
          onclick: () => pickImage(b, wrap),
          ondrop: async (e: DragEvent) => {
            e.preventDefault()
            const f = Array.from(e.dataTransfer?.files ?? [])[0]
            if (f) await applyImage(b, f, wrap)
          },
          ondragover: (e: Event) => e.preventDefault(),
        }),
      )
    }
    const cap = el2('input', {
      class: 'b-caption',
      type: 'text',
      placeholder: 'Caption (optional)',
      value: b.caption ?? '',
      oninput: (e: Event) => {
        b.caption = (e.target as HTMLInputElement).value
        scheduleSave()
      },
    })
    wrap.append(cap)
    return wrap
  }

  function pickImage(b: Block, wrap: HTMLElement) {
    const input = el2('input', { type: 'file', accept: 'image/*' }) as HTMLInputElement
    input.style.display = 'none'
    input.addEventListener('change', async () => {
      const f = input.files?.[0]
      input.remove()
      if (f) await applyImage(b, f, wrap)
    })
    document.body.append(input)
    input.click()
  }

  async function applyImage(b: Block, file: File, wrap: HTMLElement) {
    b.src = await fileToImageSrc(file)
    b.alt = file.name.replace(/\.\w+$/, '')
    toast('Image added — it is stored inside the note')
    void wrap
    commit()
  }

  function linkBody(b: Block): HTMLElement {
    const info = linkInfo(b.url ?? '')
    const kind = b.kind ?? info.kind
    const card = el2('div', { class: `b-link k-${kind}${b.embed ? ' has-embed' : ''}`, dataset: { id: b.id } })
    const head = el2('div', { class: 'link-head' })
    head.append(
      el2('img', {
        class: 'favicon',
        src: `https://duckduckgo.com/icons/?q=${encodeURIComponent(info.host)}&s=64`,
        alt: '',
        loading: 'lazy',
        onerror: (e: Event) => ((e.target as HTMLImageElement).style.visibility = 'hidden'),
      }),
      el2('span', { class: 'link-host', text: info.host || 'link' }),
      el2('span', { class: `badge b-${kind}`, text: kind }),
    )

    const label = el2('div', {
      class: 'link-label',
      contenteditable: 'true',
      spellcheck: 'false',
      text: b.label ?? '',
      oninput: (e: Event) => {
        b.label = (e.target as HTMLElement).textContent ?? ''
        scheduleSave()
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          label.blur()
        }
      },
    })
    if (!b.label) label.setAttribute('data-placeholder', 'Title of the video / article')

    const urlRow = el2('div', { class: 'link-url' }, el2('input', {
      class: 'link-input',
      type: 'url',
      placeholder: 'Paste a link — https://…',
      value: b.url ?? '',
      oninput: (e: Event) => {
        b.url = safeUrl((e.target as HTMLInputElement).value)
        if (!b.label) {
          b.label = defaultLabelForUrl(b.url)
          label.textContent = b.label
        }
        b.kind = b.kind ?? linkInfo(b.url).kind
        scheduleSave()
      },
    }))

    const noteField = el2('input', {
      class: 'link-note',
      type: 'text',
      placeholder: 'Why you saved this / what to watch for…',
      value: b.note ?? '',
      oninput: (e: Event) => {
        b.note = (e.target as HTMLInputElement).value
        scheduleSave()
      },
    })

    const tools = el2('div', { class: 'link-tools' })
    for (const part of [
      el2('button', {
        class: `mini${b.starred ? ' on' : ''}`,
        type: 'button',
        title: 'Star',
        html: icons.star,
        onclick: () => {
          b.starred = !b.starred
          commit()
        },
      }),
      el2('button', {
        class: `mini${b.read ? ' on' : ''}`,
        type: 'button',
        title: b.read ? 'Mark as to revisit' : 'Mark as read/watched',
        html: icons.check,
        onclick: () => {
          b.read = !b.read
          commit()
        },
      }),
      el2('button', {
        class: `mini${b.embed ? ' on' : ''}`,
        type: 'button',
        title: 'Preview inside the note (video only)',
        html: icons.play,
        onclick: () => {
          b.embed = !b.embed
          commit()
        },
      }),
      info.url
        ? el2('a', {
            class: 'mini open',
            href: info.url,
            target: '_blank',
            rel: 'noopener noreferrer',
            title: 'Open in a new tab',
            html: icons.external,
          })
        : null
      ] as (Node | null)[]) if (part) tools.append(part)

    card.append(head, label, urlRow, noteField, tools)

    if (b.embed && info.embedUrl) {
      const player = el2('div', { class: 'player' })
      const poster = info.poster
        ? el2('img', { class: 'poster', src: info.poster, alt: '', loading: 'lazy' })
        : null
      const play = el2('button', {
        class: 'play-btn',
        type: 'button',
        title: 'Load player',
        html: `${icons.play}<span>Play</span>`,
      })
      play.addEventListener('click', () => {
        player.replaceChildren(
          el2('iframe', {
            class: 'embed-frame',
            src: info.embedUrl!,
            allow: 'accelerometer; autoplay; clipboard-write; encrypted-media; picture-in-picture',
            allowfullscreen: true,
            referrerpolicy: 'strict-origin-when-cross-origin',
          }),
        )
      })
      player.append(el2('div', { class: 'poster-box' }, poster, play))
      card.append(player)
    }
    card.addEventListener('paste', async (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text')?.trim()
      if (text && /^https?:\/\//.test(text)) {
        e.preventDefault()
        b.url = text
        b.label = defaultLabelForUrl(text)
        b.kind = linkInfo(text).kind
        commit()
      }
    })
    return card
  }

  /* ------------------------------------------------------------- utilities */

  function el2(tag: string, props: Record<string, unknown> = {}, ...kids: (Node | string | null)[]) {
    const node = document.createElement(tag) as HTMLElement
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue
      if (k === 'class') node.className = String(v)
      else if (k === 'html') node.innerHTML = String(v)
      else if (k === 'text') node.textContent = String(v)
      else if (k === 'dataset') Object.assign(node.dataset, v as object)
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as (...a: unknown[]) => void)
      else if (typeof v === 'boolean') {
        if (v) node.setAttribute(k, '')
      } else node.setAttribute(k, String(v))
    }
    for (const kid of kids) if (kid) node.append(typeof kid === 'string' ? document.createTextNode(kid) : (kid as Node))
    return node
  }

  const newBlock = (type: Block['type'], extra: Partial<Block> = {}): Block => ({
    id: uid('b'),
    type,
    content: type === 'text' ? '' : undefined,
    ...extra,
  })

  let currentRow: HTMLElement | null = null
  const getCurrentRow = () => currentRow

  function insertAfter(id: string, ...fresh: Block[]) {
    const at = blocks.findIndex((b) => b.id === id)
    blocks.splice(at + 1, 0, ...fresh)
  }

  function commit() {
    serialize()
    render()
    scheduleSave()
  }

  function render(focus?: { id: string; offset: number | null } | false) {
    byId.clear()
    rows.clear()
    programmatic = true
    host.replaceChildren(...blocks.map((b) => {
      const row = rowEl(b)
      rows.set(b.id, row)
      return row
    }))
    applyListStyling()
    programmatic = false
    if (focus) {
      const target = rows.get(focus.id)?.querySelector<HTMLElement>('[contenteditable="true"]')
      if (target) {
        target.focus()
        setCaret(target, focus.offset)
      }
    }
    mark()
  }

  /** Numbers and bullets are drawn with CSS; here we only stamp the ordinal. */
  function applyListStyling() {
    let counter = 0
    let prevIndent = -1
    for (const b of blocks) {
      if (b.type !== 'numbered') {
        counter = 0
        prevIndent = -1
        continue
      }
      const indent = b.indent ?? 0
      if (indent === 0 || prevIndent !== indent) counter = 0
      counter += 1
      prevIndent = indent
      rows.get(b.id)?.style.setProperty('--num', `"${counter}."`)
    }
  }

  function serialize() {
    for (const [id, row] of rows) {
      const b = byId.get(id)
      if (!b) continue
      const content = row.querySelector<HTMLElement>('[contenteditable="true"]')
      if (b.type === 'code') b.content = content?.innerText ?? ''
      else if (b.type !== 'divider' && b.type !== 'image' && b.type !== 'link') {
        b.content = sanitizeHtml(content?.innerHTML ?? '')
      }
    }
  }

  function collect(): Block[] {
    serialize()
    return blocks.map((b) => stripEmpty({ ...b }))
  }

  /** Drop keys that carry no information, so stored JSON and Markdown stay clean. */
  const stripEmpty = (b: Block): Block => {
    const out: Record<string, unknown> = { id: b.id, type: b.type }
    const keep: [keyof Block, unknown][] = [
      ['content', (b.content ?? '').trim() ? b.content : undefined],
      ['indent', b.indent && b.indent > 0 ? b.indent : undefined],
      ['checked', b.type === 'todo' ? !!b.checked : undefined],
      ['collapsed', b.type === 'toggle' ? !!b.collapsed : undefined],
      ['language', b.language && b.language !== 'plain' ? b.language : undefined],
      ['src', b.src || undefined],
      ['alt', b.alt || undefined],
      ['caption', b.caption || undefined],
      ['url', b.url || undefined],
      ['label', b.label || undefined],
      ['note', b.note || undefined],
      ['kind', b.kind || undefined],
      ['starred', b.starred ? true : undefined],
      ['read', b.read ? true : undefined],
      ['embed', b.embed ? true : undefined],
      ['addedAt', b.addedAt || undefined],
    ]
    for (const [k, v] of keep) if (v !== undefined) out[k] = v
    return out as unknown as Block
  }

  const save = debounce(async () => {
    if (!dirty) return
    dirty = false
    onSave(collect())
  }, 700)

  function scheduleSave() {
    dirty = true
    mark()
    save()
  }

  function mark() {
    const pill = host.parentElement?.querySelector<HTMLElement>('.save-state')
    if (pill) pill.dataset.state = dirty ? 'saving' : 'saved'
  }

  /* -------------------------------------------------------------- keyboard */

  host.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (target.isContentEditable) onKeydown(e, target)
  })
  host.addEventListener('input', (e) => {
    if (programmatic) return
    const target = e.target as HTMLElement
    const row = target.closest?.('.brow')
    if (!row) return
    if (target.isContentEditable) target.toggleAttribute('data-empty', !target.innerText.trim())
    scheduleSave()
  })
  host.addEventListener('paste', (e) => {
    const target = e.target as HTMLElement
    if (target.isContentEditable) void onPaste(e as ClipboardEvent, target)
  })
  document.addEventListener('pointerdown', (e) => {
    const row = (e.target as HTMLElement).closest?.('.brow')
    if (row) currentRow = row as HTMLElement
  })

  function onKeydown(e: KeyboardEvent, target: HTMLElement) {
    const row = target.closest('.brow') as HTMLElement
    const id = row.getAttribute('data-id')!
    const b = byId.get(id)!
    const at = caretOffset(target) ?? 0

    if (e.key === '/' && at === 0 && !e.ctrlKey && !e.metaKey && !e.altKey && textOf(target) === '') {
      // "/" on an empty block opens the command menu; remove the slash itself
      e.preventDefault()
      const mode = b.type === 'text' ? 'turn' : 'insert'
      setTimeout(() => openSlash(id, mode), 0)
    }

    if (e.key === 'Enter' && e.altKey) {
      e.preventDefault()
      if (b.type === 'toggle') {
        b.collapsed = !b.collapsed
        commit()
        focusRow(id, at)
      }
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault()
      const rest = splitAtCaret(target)
      const canContinue = ['bulleted', 'numbered', 'todo'].includes(b.type)
      if (textOf(target).trim() === '' && !rest && canContinue) {
        b.type = 'text'
        b.indent = b.indent ? b.indent - 1 : 0
        commit()
        openSlash(id, 'turn', false)
        focusRow(id, 0)
        return
      }
      let type: Block['type'] = canContinue ? b.type : b.type === 'toggle' ? 'text' : 'text'
      const indent = b.type === 'toggle' ? (b.indent ?? 0) + 1 : b.indent ?? 0
      const fresh = newBlock(type, {
        indent,
        content: rest ?? '',
        ...(type === 'todo' ? { checked: false } : {}),
      })
      if (b.type === 'toggle') {
        const idx = blocks.findIndex((x) => x.id === id)
        blocks.splice(idx + 1, 0, fresh)
      } else insertAfter(id, fresh)
      if (!rest) b.content = ''
      else serialize()
      render({ id: fresh.id, offset: 0 })
      scheduleSave()
      return
    }

    if (e.key === 'Backspace' && at === 0 && !hasSelection()) {
      const idx = blocks.findIndex((x) => x.id === id)
      if (idx <= 0) return
      const prev = blocks[idx - 1]!
      if (prev.type === 'divider' || prev.type === 'image' || prev.type === 'link') {
        e.preventDefault()
        blocks.splice(idx - 1, 1)
        commit()
        focusRow(id, 0)
        return
      }
      e.preventDefault()
      const cur = textOf(target)
      const prevRow = rows.get(prev.id)
      const prevContent = prevRow?.querySelector<HTMLElement>('[contenteditable="true"]')
      const before = prevContent?.innerHTML ?? ''
      const offsetBefore = prevContent ? prevContent.innerText.length : 0
      if (prevContent) prevContent.innerHTML = sanitizeHtml(before + (textOf(target) ? target.innerHTML : ''))
      b.content = ''
      blocks.splice(idx, 1)
      serialize()
      render({ id: prev.id, offset: prev.type === 'code' ? offsetBefore : null })
      void cur
      scheduleSave()
      return
    }

    if (e.key === 'Tab') {
      e.preventDefault()
      const dir = e.shiftKey ? -1 : 1
      const idx = blocks.findIndex((x) => x.id === id)
      if (dir > 0) {
        const prev = blocks[idx - 1]
        const max = prev ? Math.min(4, (prev.indent ?? 0) + 1) : 0
        if (max === 0 && !prev) return
        b.indent = Math.min(4, (b.indent ?? 0) + 1)
      } else b.indent = Math.max(0, (b.indent ?? 0) - 1)
      commit()
      focusRow(id, at)
      return
    }

    if ((e.altKey) && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault()
      const idx = blocks.findIndex((x) => x.id === id)
      const to = e.key === 'ArrowDown' ? idx + 1 : idx - 1
      if (to < 0 || to >= blocks.length) return
      const [m] = blocks.splice(idx, 1)
      blocks.splice(to, 0, m!)
      commit()
      focusRow(id, at)
      return
    }

    if (e.key === 'ArrowUp' && at === 0 && !hasSelection()) {
      const idx = blocks.findIndex((x) => x.id === id)
      const prev = blocks[idx - 1]
      if (prev && prev.type !== 'divider') {
        e.preventDefault()
        focusRowEnd(prev.id)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      const len = target.innerText.length
      if (at !== len || hasSelection()) return
      const idx = blocks.findIndex((x) => x.id === id)
      const next = blocks[idx + 1]
      if (next && next.type !== 'divider') {
        e.preventDefault()
        focusRow(next.id, 0)
      }
      return
    }

    if (e.key === 'Escape' && slashOpen) {
      closeSlash()
      return
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && 'b,i,u'.includes(e.key.toLowerCase())) {
      e.preventDefault()
      document.execCommand(
        e.key.toLowerCase() === 'b' ? 'bold' : e.key.toLowerCase() === 'i' ? 'italic' : 'underline',
        false,
      )
      scheduleSave()
      refreshToolbar()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
      e.preventDefault()
      toggleInlineCode()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
      e.preventDefault()
      void flush()
      toast('Saved to this device')
      return
    }

    // markdown shortcuts: type "- " to get a bullet, "# " a heading, etc.
    if (at === 1 || at === 2 || at === 3) {
      const ch = textOf(target).slice(0, at)
      const map: Record<string, Block['type']> = {
        '- ': 'bulleted',
        '* ': 'bulleted',
        '1. ': 'numbered',
        '> ': 'quote',
        '[] ': 'todo',
        '[x] ': 'todo',
        '# ': 'h1',
        '## ': 'h2',
        '### ': 'h3',
        '```': 'code',
      }
      const type = map[ch]
      if (type) {
        e.preventDefault()
        b.type = type
        if (type === 'todo') b.checked = ch.startsWith('[x]')
        target.innerHTML = ''
        setCaret(target, 0)
        commit()
        focusRow(id, 0)
        return
      }
    }
  }

  function hasSelection() {
    const sel = document.getSelection()
    return !!sel && !sel.isCollapsed
  }

  const textOf = (node: HTMLElement) => node.innerText.replace(/\u00a0/g, ' ')

  function focusRow(id: string, offset: number | null) {
    const target = rows.get(id)?.querySelector<HTMLElement>('[contenteditable="true"]')
    if (target) {
      target.focus()
      setCaret(target, offset)
    }
  }
  function focusRowEnd(id: string) {
    const target = rows.get(id)?.querySelector<HTMLElement>('[contenteditable="true"]')
    if (target) {
      target.focus()
      setCaret(target, target.innerText.length)
    }
  }

  /** Moves everything after the caret into a returned HTML string. */
  function splitAtCaret(content: HTMLElement): string | null {
    const sel = document.getSelection()
    if (!sel || !sel.rangeCount) return null
    const range = sel.getRangeAt(0)
    if (!range.collapsed) range.deleteContents()
    const tail = range.cloneRange()
    tail.selectNodeContents(content)
    tail.setStart(range.endContainer, range.endOffset)
    const frag = tail.extractContents()
    if (frag.textContent?.trim() || frag.querySelector('br,b,i,code,a')) {
      const div = document.createElement('div')
      div.append(frag)
      const html = div.innerHTML.trim()
      return html && html !== '<br>' ? html : null
    }
    return null
  }

  /* ------------------------------------------------------------- paste */

  function imageFromClipboard(e: ClipboardEvent): File | null {
    const items = Array.from(e.clipboardData?.items ?? [])
    for (const it of items) if (it.type.startsWith('image/')) return it.getAsFile()
    return null
  }

  async function onPaste(e: ClipboardEvent, target: HTMLElement) {
    const row = target.closest('.brow') as HTMLElement
    const id = row.getAttribute('data-id')!
    const b = byId.get(id)!
    const image = imageFromClipboard(e)
    if (image) {
      e.preventDefault()
      const fresh = newBlock('image', { src: await fileToImageSrc(image), alt: 'pasted' })
      if (textOf(target).trim() === '') {
        blocks.splice(blocks.findIndex((x) => x.id === id), 1, { ...b, ...fresh })
        commit()
      } else {
        insertAfter(id, fresh)
        commit()
      }
      return
    }
    const html = e.clipboardData?.getData('text/html')
    const text = e.clipboardData?.getData('text/plain')
    if (!html && !text) return
    e.preventDefault()
    if (text?.match(/^https?:\/\/\S+$/)) {
      const info = linkInfo(text)
      b.url = text
      b.label = defaultLabelForUrl(text)
      b.kind = info.kind
      b.addedAt = Date.now()
      if (b.type === 'text') {
        b.type = 'link'
        b.content = ''
        commit()
        toast('Link turned into a card')
      } else {
        insertAfter(id, newBlock('link', { url: text, label: b.label, kind: info.kind, embed: info.kind === 'video', addedAt: Date.now() }))
        commit()
        toast('Link added below')
      }
      return
    }
    const incoming = html ? htmlToBlocks(html) : mdToBlocks(text ?? '')
    if (!incoming.length) return
    const idx = blocks.findIndex((x) => x.id === id)
    if (textOf(target).trim() === '' && incoming.length) {
      blocks.splice(idx, 1, ...incoming)
    } else {
      blocks.splice(idx + 1, 0, ...incoming)
    }
    commit()
    toast(`${incoming.length} block${incoming.length > 1 ? 's' : ''} pasted`)
  }

  function htmlToBlocks(html: string): Block[] {
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const out: Block[] = []
    const inline = (node: Element) => stripToInline(node.innerHTML)
    const push = (type: Block['type'], content: string, extra: Partial<Block> = {}) => {
      if (!content.trim() && !extra.src && !extra.url) return
      out.push(newBlock(type, { content, ...extra }))
    }
    const scan = (parent: Element) => {
      for (const node of Array.from(parent.children)) {
        const tag = node.tagName
        if (/^H[1-3]$/.test(tag)) push(tag.toLowerCase() as Block['type'], inline(node))
        else if (tag === 'H4' || tag === 'H5' || tag === 'H6') push('h3', inline(node))
        else if (tag === 'P') push('text', inline(node))
        else if (tag === 'UL' || tag === 'OL') {
          for (const li of Array.from(node.children)) {
            const checkbox = li.querySelector<HTMLInputElement>('input[type=checkbox]')
            if (checkbox) push('todo', inline(li), { checked: checkbox.checked })
            else push(tag === 'OL' ? 'numbered' : 'bulleted', inline(li))
          }
        } else if (tag === 'BLOCKQUOTE') push('quote', inline(node))
        else if (tag === 'PRE') push('code', node.textContent ?? '')
        else if (tag === 'HR') out.push(newBlock('divider'))
        else if (tag === 'IMG') {
          const src = node.getAttribute('src') ?? ''
          if (src.startsWith('data:')) out.push(newBlock('image', { src, alt: node.getAttribute('alt') ?? '' }))
        } else if (tag === 'DIV' || tag === 'BODY') scan(node)
        else push('text', inline(node))
      }
    }
    scan(doc.body)
    if (!out.length && doc.body.textContent?.trim()) out.push(newBlock('text', { content: escapeHtml(doc.body.textContent.trim()) }))
    return out
  }

  function mdToBlocks(text: string): Block[] {
    return text
      .split(/\n{2,}/)
      .flatMap((para) =>
        para
          .split('\n')
          .map((l) => l)
          .filter((l) => l.trim() !== ''),
      )
      .map((line) => {
        const t = line.trim()
        const h = t.match(/^(#{1,3})\s+(.*)$/)
        if (h) return newBlock(h[1]!.length === 1 ? 'h1' : h[1]!.length === 2 ? 'h2' : 'h3', { content: escapeHtml(h[2]!) })
        if (/^[-*]\s+\[( |x)\]\s+/i.test(t))
          return newBlock('todo', { content: escapeHtml(t.replace(/^[-*]\s+\[( |x)\]\s+/i, '')), checked: /\[x\]/i.test(t) })
        if (/^[-*]\s+/.test(t)) return newBlock('bulleted', { content: escapeHtml(t.replace(/^[-*]\s+/, '')) })
        if (/^\d+[.)]\s+/.test(t)) return newBlock('numbered', { content: escapeHtml(t.replace(/^\d+[.)]\s+/, '')) })
        if (/^>\s?/.test(t)) return newBlock('quote', { content: escapeHtml(t.replace(/^>\s?/, '')) })
        if (/^```/.test(t)) return newBlock('code', { content: t.replace(/```/g, '') })
        if (/^---+$/.test(t)) return newBlock('divider')
        if (/^!\[.*\]\(.*\)$/.test(t)) {
          const m = t.match(/^!\[(.*?)\]\((.*?)\)$/)
          return newBlock('image', { src: m?.[2] ?? '', alt: m?.[1] ?? '' })
        }
        const lone = t.match(/^\[(.*?)\]\(<?(https?:\/\/[^)>\s]+)>?\)$/)
        if (lone) return newBlock('link', { url: lone[2]!, label: lone[1] || lone[2]!, addedAt: Date.now() })
        return newBlock('text', { content: escapeHtml(t) })
      })
      .filter((b) => b.type === 'divider' || b.type === 'image' || b.type === 'link' || (b.content ?? '').trim())
  }

  /* ------------------------------------------------------------- slash menu */

  function openSlash(id: string, mode: 'turn' | 'insert', preferBelow = false) {
    closeSlash()
    const row = rows.get(id)
    if (!row) return
    const box = el2('div', { class: 'slash', role: 'listbox' })
    const input = el2('input', {
      class: 'slash-q',
      type: 'text',
      placeholder: 'Type to filter — heading, to-do, image, link…',
    })
    const list = el2('div', { class: 'slash-list' })
    box.append(input, list)
    document.body.append(box)
    const rect = row.getBoundingClientRect()
    const fits = window.innerHeight - rect.bottom > 340
    box.style.top = `${(preferBelow || fits ? rect.bottom + 6 : Math.max(60, rect.top - 340))}px`
    box.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`
    slashOpen = { el: box, items: SLASH, active: 0, row, mode }
    const paint = () => {
      const q = (input as HTMLInputElement).value.trim().toLowerCase()
      const items = SLASH.filter((s) => !q || s.search.includes(q) || s.label.toLowerCase().includes(q))
      slashOpen!.items = items
      slashOpen!.active = Math.min(slashOpen!.active, Math.max(0, items.length - 1))
      list.replaceChildren(
        ...items.map((it, i) =>
          el2('button', {
            class: 'slash-item' + (i === slashOpen!.active ? ' on' : ''),
            type: 'button',
            dataset: { i: String(i) },
            onclick: () => applySlash(it, id),
            onmouseenter: () => {
              slashOpen!.active = i
              list.querySelectorAll('.slash-item').forEach((n, j) => n.classList.toggle('on', j === i))
            },
          },
            el2('span', { class: 'slash-glyph', text: it.glyph }),
            el2('span', { class: 'slash-txt' }, el2('b', { text: it.label }), el2('span', { class: 'slash-hint', text: it.hint })),
          ),
        ),
      )
      if (!items.length) list.append(el2('p', { class: 'slash-empty', text: 'Nothing matches that. Esc to close.' }))
    }
    paint()
    input.addEventListener('input', paint)
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      const st = slashOpen
      if (!st) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        st.active = (st.active + (e.key === 'ArrowDown' ? 1 : -1) + st.items.length) % st.items.length
        paint()
        list.querySelector('.slash-item.on')?.scrollIntoView({ block: 'nearest' })
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const item = st.items[st.active]
        if (item) applySlash(item, id)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        closeSlash()
        focusRow(id, null)
      }
    })
    input.addEventListener('blur', () => setTimeout(closeSlash, 180))
    input.focus()
  }

  function closeSlash() {
    slashOpen?.el.remove()
    slashOpen = null
  }

  async function applySlash(item: SlashItem, id: string) {
    const b = byId.get(id)
    if (!b) return
    closeSlash()
    if (item.key === 'link' || item.key === 'video') {
      const res = await askLink(item.key === 'video' ? 'video' : undefined)
      if (!res) {
        focusRow(id, null)
        return
      }
      const fresh = newBlock('link', { ...res, addedAt: Date.now(), embed: res.kind === 'video' })
      if (b.type === 'text' && !textOf(rows.get(id)!.querySelector('[contenteditable="true"]') as HTMLElement)) {
        blocks.splice(blocks.findIndex((x) => x.id === id), 1, fresh)
      } else insertAfter(id, fresh)
      commit()
      return
    }
    if (item.key === 'image') {
      const fresh = newBlock('image', {})
      insertAfter(id, fresh)
      commit()
      const row = rows.get(fresh.id)
      row?.querySelector<HTMLElement>('.image-empty')?.click()
      return
    }
    if (item.kind === 'insert') {
      insertAfter(id, newBlock(item.type))
      commit()
      focusRow(blocks[blocks.findIndex((x) => x.id === id) + 1]!.id, 0)
      return
    }
    b.type = item.type
    if (item.type === 'todo') b.checked = false
    if (item.type === 'toggle') b.collapsed = false
    commit()
    focusRow(id, null)
  }

  async function askLink(prefer?: 'video') {
    const res = await modal({
      title: prefer === 'video' ? 'Add a video' : 'Add a link',
      subtitle: 'It becomes a card: title, type, a note from you, and a player for videos.',
      fields: [
        { name: 'url', label: 'Link', placeholder: 'https://youtube.com/watch?v=…' },
        { name: 'label', label: 'Title', placeholder: 'Optional — auto-filled from the link' },
        { name: 'note', label: 'Your note about it', placeholder: 'Why it is here, what to look for' },
      ],
      actions: [
        { label: 'Cancel', kind: 'ghost', value: '' },
        { label: 'Add link', kind: 'primary', value: 'ok' },
      ],
    })
    if (!res?.url) return null
    const info = linkInfo(res.url)
    return {
      url: info.url,
      label: res.label?.trim() || defaultLabelForUrl(info.url),
      note: res.note?.trim() || undefined,
      kind: prefer === 'video' ? ('video' as const) : info.kind,
      embed: info.kind === 'video' || prefer === 'video',
    }
  }

  /* ------------------------------------------------------------ row menu */

  function rowMenu(id: string, anchor: HTMLElement) {
    const b = byId.get(id)
    if (!b) return
    const menu = el2('div', { class: 'ctx' })
    const act = (label: string, fn: () => void, extra: Record<string, unknown> = {}) => {
      menu.append(el2('button', { class: 'ctx-item', type: 'button', text: label, onclick: () => { menu.remove(); fn() }, ...extra }))
    }
    act('Duplicate', () => {
      serialize()
      const copy = { ...b, id: uid('b') }
      insertAfter(id, copy)
      commit()
    })
    act('Delete', () => {
      const idx = blocks.findIndex((x) => x.id === id)
      const snapshot = blocks[idx]!
      blocks.splice(idx, 1)
      commit()
      toast('Block deleted', {
        label: 'Undo',
        run: () => {
          blocks.splice(idx, 0, snapshot)
          commit()
        },
      })
    }, { class: 'ctx-item danger' })
    menu.append(el2('div', { class: 'ctx-sep' }))
    for (const t of ['text', 'h2', 'bulleted', 'todo', 'quote'] as Block['type'][]) {
      if (t === b.type) continue
      act(`Turn into ${t === 'h2' ? 'heading' : t}`, () => {
        b.type = t
        commit()
      })
    }
    document.body.append(menu)
    const r = anchor.getBoundingClientRect()
    menu.style.top = `${r.bottom + 4}px`
    menu.style.left = `${Math.max(8, r.left - 60)}px`
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        menu.remove()
        document.removeEventListener('mousedown', close, true)
      }
    }
    setTimeout(() => document.addEventListener('mousedown', close, true), 0)
  }

  /* ------------------------------------------------------- format toolbar */

  const toolbar = el2('div', { class: 'fmt', hidden: true })
  const fmtBtn = (label: string, cmd: string, cls = '') =>
    el2('button', {
      class: `fmt-btn ${cls}`,
      type: 'button',
      title: label,
      html: label,
      onmousedown: (e: Event) => e.preventDefault(),
      onclick: () => {
        if (cmd === 'code') toggleInlineCode()
        else if (cmd === 'link') void askLinkForSelection()
        else document.execCommand(cmd, false)
        scheduleSave()
        refreshToolbar()
      },
    })
  toolbar.append(
    fmtBtn('<b>B</b>', 'bold'),
    fmtBtn('<i>I</i>', 'italic'),
    fmtBtn('<u>U</u>', 'underline'),
    fmtBtn('<s>S</s>', 'strikeThrough', 'strike'),
    fmtBtn('<span class="c">code</span>', 'code'),
    fmtBtn('🔗', 'link'),
    fmtBtn('Clear', 'removeFormat', 'clear'),
  )
  document.body.append(toolbar)

  function toggleInlineCode() {
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed) return
    const existing = sel.anchorNode?.parentElement?.closest('code')
    if (existing) {
      existing.replaceWith(...Array.from(existing.childNodes))
      return
    }
    const range = sel.getRangeAt(0)
    const code = document.createElement('code')
    try {
      range.surroundContents(code)
    } catch {
      code.append(range.extractContents())
      range.insertNode(code)
    }
  }

  async function askLinkForSelection() {
    const sel = document.getSelection()
    if (!sel || sel.isCollapsed) return
    const text = sel.toString()
    const res = await modal({
      title: 'Add link',
      fields: [{ name: 'url', label: 'URL', placeholder: 'https://…', value: 'https://' }],
      actions: [
        { label: 'Cancel', kind: 'ghost', value: '' },
        { label: `Link “${text.slice(0, 24)}”`, kind: 'primary', value: 'ok' },
      ],
    })
    if (res?.url) {
      document.execCommand('createLink', false, safeUrl(res.url))
      const anchor = document.getSelection()?.anchorNode?.parentElement?.closest('a')
      anchor?.setAttribute('target', '_blank')
      anchor?.setAttribute('rel', 'noopener noreferrer')
      scheduleSave()
    }
  }

  function refreshToolbar() {
    const sel = document.getSelection()
    const show = !!sel && !sel.isCollapsed && sel.rangeCount > 0 && (
      host.contains(sel.anchorNode) || host.contains(sel.focusNode)
    )
    if (!show) {
      toolbar.hidden = true
      return
    }
    const rect = sel!.getRangeAt(0).getBoundingClientRect()
    toolbar.hidden = false
    toolbar.style.top = `${Math.max(52, rect.top - 42 + window.scrollY)}px`
    toolbar.style.left = `${Math.max(8, rect.left + rect.width / 2 - toolbar.offsetWidth / 2)}px`
  }
  document.addEventListener('selectionchange', refreshToolbar)
  host.addEventListener('mouseup', () => setTimeout(refreshToolbar, 0))

  /* ------------------------------------------------------------- start */

  host.addEventListener('click', (e) => {
    // clicking under the last block should start a new one
    if ((e.target as HTMLElement).closest('.brow')) return
    const last = blocks.at(-1)
    if (last && (last.type !== 'text' || (last.content ?? '').trim())) {
      const fresh = newBlock('text')
      blocks.push(fresh)
      commit()
      focusRow(fresh.id, 0)
    } else if (last) focusRow(last.id, null)
  })

  async function flush() {
    if (!dirty) return
    dirty = false
    onSave(collect())
  }

  render(false)
  scheduleSave()

  return {
    flush,
    replaceBlocks(next) {
      blocks = next.map((b) => ({ ...b }))
      render(false)
    },
    destroy() {
      document.removeEventListener('selectionchange', refreshToolbar)
      toolbar.remove()
      closeSlash()
      void getCurrentRow
    },
  }
}
