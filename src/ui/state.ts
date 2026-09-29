import type { Note, Subject, Topic } from '../core/types'

export type Route =
  | { view: 'all' }
  | { view: 'subject'; subjectId: string }
  | { view: 'topic'; subjectId: string; topicId: string }
  | { view: 'note'; subjectId: string; topicId: string; noteId: string }
  | { view: 'library'; filter?: string }

export const routes = {
  all: '#/',
  subject: (s: string) => `#/s/${s}`,
  topic: (s: string, t: string) => `#/s/${s}/t/${t}`,
  note: (s: string, t: string, n: string) => `#/s/${s}/t/${t}/n/${n}`,
  library: (filter?: string) => `#/library${filter ? `/${filter}` : ''}`,
}

export function parseHash(): Route {
  const h = location.hash.replace(/^#\/?/, '')
  const p = h.split('/').filter(Boolean)
  if (!p.length) return { view: 'all' }
  if (p[0] === 'library') return { view: 'library', filter: p[1] }
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
export const go = (hash: string) => {
  if (location.hash === hash) document.dispatchEvent(new Event('data'))
  else location.hash = hash
}

/**
 * Tiny global store. The editor owns its own DOM while you type, so data
 * changes are announced with an event instead of a re-render cascade.
 */
class AppStore {
  readonly bus = new EventTarget()
  route: Route = parseHash()
  subjects: Subject[] = []
  /** memoised for breadcrumbs / tab titles */
  subjectById = new Map<string, Subject>()
  topicById = new Map<string, Topic>()
  noteById = new Map<string, Note>()
  sidebarOpen = false
  paletteOpen = false

  emit() {
    this.bus.dispatchEvent(new Event('data'))
  }

  onChange(fn: () => void) {
    this.bus.addEventListener('data', fn)
    return () => this.bus.removeEventListener('data', fn)
  }
}

export const App = new AppStore()

export const titleOf = (subjectId?: string) => (subjectId ? App.subjectById.get(subjectId)?.name ?? 'Notes' : 'All subjects')
