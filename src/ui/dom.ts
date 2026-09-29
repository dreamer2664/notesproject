import { icons } from './icons'

type Kid = Node | string | null | undefined
export function el(tag: 'input', props?: Record<string, unknown>, ...kids: Kid[]): HTMLInputElement
export function el<T extends HTMLElement = HTMLDivElement>(tag: string, props?: Record<string, unknown>, ...kids: Kid[]): T
export function el(tag: string, props: Record<string, unknown> = {}, ...kids: Kid[]): HTMLElement {
  const node = document.createElement(tag) as HTMLElement
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = String(v)
    else if (k === 'html') node.innerHTML = String(v)
    else if (k === 'text') node.textContent = String(v)
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v)
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v as (...a: any[]) => void)
    else if (k === 'dataset') Object.assign(node.dataset, v as object)
    else node.setAttribute(k, String(v))
  }
  for (const kid of kids) if (kid !== null && kid !== undefined) node.append(typeof kid === 'string' ? document.createTextNode(kid) : kid)
  return node
}

export const button = (
  iconName: keyof typeof icons | null,
  label: string,
  onClick: () => void,
  opts: { class?: string; title?: string; html?: string } = {},
) =>
  el('button', {
    class: opts.class ?? 'btn',
    type: 'button',
    title: opts.title ?? label,
    'aria-label': label,
    onclick: onClick,
    html: opts.html ?? (iconName ? icons[iconName] : label),
  })

/** Modal dialog. Resolves on submit, null on dismiss. */
export function modal(opts: {
  title: string
  subtitle?: string
  body?: HTMLElement
  fields?: { name: string; label: string; value?: string; placeholder?: string; type?: string; list?: string[] }[]
  datalist?: { id: string; options: string[] }[]
  actions?: { label: string; kind?: 'primary' | 'danger' | 'ghost'; value: string }[]
  wide?: boolean
}): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const inputs: Record<string, HTMLInputElement> = {}
    const form = el('form', { class: 'modal' + (opts.wide ? ' wide' : '') })
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      close(values())
    })
    const values = () => {
      const out: Record<string, string> = {}
      for (const [k, input] of Object.entries(inputs)) out[k] = input.value
      return out
    }

    form.append(
      el('header', {}, el('h2', { text: opts.title }), opts.subtitle ? el('p', { class: 'sub', text: opts.subtitle }) : null),
    )
    for (const f of opts.fields ?? []) {
      const input = el('input', {
        class: 'field',
        name: f.name,
        placeholder: f.placeholder ?? '',
        value: f.value ?? '',
        type: f.type ?? 'text',
        list: f.list,
        autocomplete: 'off',
        spellcheck: 'false',
      })
      inputs[f.name] = input as HTMLInputElement
      form.append(el('label', { class: 'field-row' }, el('span', { class: 'field-label', text: f.label }), input))
    }
    if (opts.body) form.append(opts.body)
    if (opts.datalist)
      for (const d of opts.datalist)
        form.append(el('datalist', { id: d.id }, ...d.options.map((o) => el('option', { value: o }))))

    const actions = opts.actions ?? [
      { label: 'Cancel', kind: 'ghost', value: '' },
      { label: 'Save', kind: 'primary', value: 'ok' },
    ]
    form.append(
      el(
        'footer',
        {},
        ...actions.map((a) =>
          el('button', {
            class: `btn ${a.kind === 'primary' ? 'primary' : a.kind === 'danger' ? 'danger' : 'ghost'}`,
            type: a.kind === 'primary' ? 'submit' : 'button',
            text: a.label,
            onclick: () => (a.value === '' ? close(null) : close({ ...values(), action: a.value })),
          }),
        ),
      ),
    )

    const scrim = el('div', { class: 'scrim', tabindex: '-1' }, form)
    const close = (result: Record<string, string> | null) => {
      scrim.classList.add('closing')
      setTimeout(() => scrim.remove(), 130)
      document.removeEventListener('keydown', onKey, true)
      resolve(result)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close(null)
      }
    }
    document.addEventListener('keydown', onKey, true)
    scrim.addEventListener('pointerdown', (e) => {
      if (e.target === scrim) close(null)
    })
    document.body.append(scrim)
    scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 130, easing: 'ease-out' })
    const first = form.querySelector<HTMLInputElement>('input')
    if (first) {
      first.focus()
      first.select()
    }
  })
}

/** Small toast with optional Undo. */
export function toast(message: string, action?: { label: string; run: () => void }) {
  const host = document.querySelector('.toasts') ?? el('div', { class: 'toasts' })
  if (!host.isConnected) document.body.append(host)
  const node = el(
    'div',
    { class: 'toast' },
    el('span', { text: message }),
    action
      ? el('button', {
          class: 'link-btn',
          text: action.label,
          onclick: () => {
            action.run()
            dismiss()
          },
        })
      : null,
  )
  const dismiss = () => {
    node.classList.add('out')
    setTimeout(() => node.remove(), 220)
  }
  node.append(el('button', { class: 'toast-x', html: icons.close, title: 'Dismiss', onclick: dismiss }))
  host.append(node)
  setTimeout(dismiss, action ? 7000 : 3200)
}

export function confirmDialog(title: string, message: string, danger = true) {
  return modal({
    title,
    subtitle: message,
    actions: [
      { label: 'Cancel', kind: 'ghost', value: '' },
      { label: danger ? 'Delete' : 'Confirm', kind: danger ? 'danger' : 'primary', value: 'ok' },
    ],
  }).then((r) => r !== null)
}

export const emojiRow = (selected: string, onPick: (e: string) => void, set: string[] = EMOJIS) => {
  const row = el('div', { class: 'emoji-row' })
  for (const e of set) {
    row.append(
      el('button', {
        class: 'emoji' + (e === selected ? ' on' : ''),
        type: 'button',
        text: e,
        onclick: () => onPick(e),
      }),
    )
  }
  return row
}

export const EMOJIS = [
  '📚','📐','🧪','🧠','💻','📊','🎯','✏️','🗒️','📝','🧩','🔤','🌍','🏛️','⚗️','🔬',
  '📈','💡','🎼','🎬','🧮','🩺','⚖️','🗺️','🧬','🔢','📰','🎨','🛠️','🧯','🚀','🧵',
]
