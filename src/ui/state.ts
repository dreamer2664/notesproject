import { domEvent } from '../core/util'
import type { Book, Note, Subject, Topic } from '../core/types'

export type Route =
  | { view: 'all' }
  | { view: 'subject'; subjectId: string }
  | { view: 'topic'; subjectId: string; topicId: string }
  | { view: 'note'; subjectId: string; topicId: string; noteId: string }
  | { view: 'library'; filter?: string }
  | { view: 'book'; bookId: string; page: number }
  | { view: 'books' }

export const routes = {
  all: '#/',
  subject: (s: string) => `#/s/${s}`,
  topic: (s: string, t: string) => `#/s/${s}/t/${t}`,
  note: (s: string, t: string, n: string) => `#/s/${s}/t/${t}/n/${n}`,
  library: (filter?: string) => `#/library${filter ? `/${filter}` : ''}`,
  books: '#/books',
  book: (id: string, page?: number) => `#/b/${id}${page ? `?p=${page}` : ''}`,
}

/** `location` is missing when these modules are imported from a plain node test. */
const hash = () => (globalThis as unknown as { location?: { hash: string } }).location?.hash ?? ''

export function parseHash(): Route {
  const h = hash().replace(/^#\/?/, '')
  const p = h.split('/').filter(Boolean)
  if (!p.length) return { view: 'all' }
  if (p[0] === 'library') return { view: 'library', filter: p[1] }
  if (p[0] === 'books') return { view: 'books' }
  if (p[0] === 'b' && p[1]) {
    const id = p[1].split('?')[0]!
    const page = Number(hash().match(/[?&]p=(\d+)/)?.[1] ?? 1)
    return { view: 'book', bookId: id, page: Number.isFinite(page) && page > 0 ? page : 1 }
  }
  if (p[0] === 's' && p[1]) {
    if (p[2] === 't' && p[3]) {
      if (p[4] === 'n' && p[5]) return { view: 'note', subjectId: p[1], topicId: p[3], noteId: p[5] }
      return { view: 'topic', subjectId: p[1], topicId: p[3] }
    }
    return { view: 'subject', subjectId: p[1] }
  }
  return { view: 'all' }
}

/** Navigate. Same-hash navigations are announced manually, since the browser stays quiet. */
export const go = (next: string) => {
  const loc = (globalThis as unknown as { location?: { hash: string } }).location
  if (!loc) return
  if (loc.hash === next) document.dispatchEvent(domEvent('data', document))
  else loc.hash = next
}

/**
 * Tiny global store. The editor owns its own DOM while you type, so data
 * changes are announced with an event instead of a re-render cascade.
 */
/** jsdom hands the harness Node's `EventTarget` on the global but its own in `window`;
 *  a bus and its events must come from the same realm or `dispatchEvent` refuses them. */
const BusCtor: typeof EventTarget =
  (globalThis as unknown as { window?: { EventTarget?: typeof EventTarget } }).window?.EventTarget ?? EventTarget

class AppStore {
  readonly bus = new BusCtor()
  route: Route = parseHash()
  subjects: Subject[] = []
  /** memoised for breadcrumbs / tab titles */
  subjectById = new Map<string, Subject>()
  topicById = new Map<string, Topic>()
  noteById = new Map<string, Note>()
  books: Book[] = []
  bookById = new Map<string, Book>()
  sidebarOpen = false
  paletteOpen = false

  emit() {
    this.bus.dispatchEvent(domEvent('data', this.bus))
  }

  onChange(fn: () => void) {
    this.bus.addEventListener('data', fn)
    return () => this.bus.removeEventListener('data', fn)
  }
}

export const App = new AppStore()

export const titleOf = (subjectId?: string) => (subjectId ? App.subjectById.get(subjectId)?.name ?? 'Notes' : 'All subjects')
