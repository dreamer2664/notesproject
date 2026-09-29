import { loadFolderHandle } from '../core/fs'
import { el } from './dom'
import { icons } from './icons'
import { exportBackup, exportToFolder, importFromFolder, newSubject, refreshFromFolder } from './actions'
import { App, type Route } from './state'
import { getSettings } from '../core/db'
import { applyTheme, toggleTheme } from './theme'

/**
 * The chrome: sidebar (topics + notes), tab bar (subjects) and the content outlet.
 * Views only ever replace the outlet's children, so the sidebar and tabs can keep
 * their own scroll positions.
 */
export interface Shell {
  tabs: HTMLElement
  sidebar: HTMLElement
  view: HTMLElement
  setSidebarOpen: (open: boolean) => void
}

export function buildShell(mount: HTMLElement, onMenu: () => void): Shell {
  mount.replaceChildren()

  const sidebar = el('aside', { class: 'side', id: 'sidebar' })
  const scrim = el('div', { class: 'drawer-scrim', onclick: () => setSidebarOpen(false) })

  const brand = el(
    'div',
    { class: 'brand' },
    el('span', { class: 'brand-mark', html: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 19.5V5.5A1.5 1.5 0 0 1 5.5 4H19v13.5"/><path d="M4 19.5A1.5 1.5 0 0 0 5.5 21H20v-3.5H5.5A1.5 1.5 0 0 0 4 19.5z"/></svg>' }),
    el('span', { class: 'brand-name', text: 'Notes' }),
  )
  const themeBtn = el('button', { class: 'icon-btn', type: 'button', title: 'Switch appearance', html: icons.moon })
  const paletteBtn = el('button', { class: 'search-cta', type: 'button', title: 'Search (⌘K)' }, el('span', { class: 'ic', html: icons.search }), el('span', { text: 'Search' }), el('kbd', { text: '⌘K' }))
  themeBtn.addEventListener('click', () => void toggleTheme().then(paintThemeIcon))
  paletteBtn.addEventListener('click', () => document.dispatchEvent(new CustomEvent('open-palette')))
  document.addEventListener('theme-change', () => {
    paintThemeIcon()
    App.emit()
  })

  const sideTop = el('div', { class: 'side-topbar' }, brand, el('div', { class: 'side-top-actions' }, themeBtn, paletteBtn))
  const sideTree = el('div', { class: 'side-tree' })
  const sideFoot = el('div', { class: 'side-foot' })
  sidebar.append(sideTop, sideTree, sideFoot)

  const menuBtn = el('button', { class: 'icon-btn only-mobile', type: 'button', title: 'Menu', html: icons.menu, onclick: onMenu })
  const tabStrip = el('div', { class: 'tabstrip' })
  const tabs = el('div', { class: 'tabs-host' })
  tabStrip.append(menuBtn, tabs, el('button', { class: 'icon-btn only-mobile', type: 'button', title: 'Search', html: icons.search, onclick: () => document.dispatchEvent(new CustomEvent('open-palette')) }))

  const view = el('main', { class: 'view', role: 'main', 'aria-live': 'polite' })
  const layout = el('div', { class: 'layout' }, sidebar, el('div', { class: 'content' }, tabStrip, view))
  mount.append(layout, scrim)

  function setSidebarOpen(open: boolean) {
    document.body.classList.toggle('drawer-open', open)
    scrim.classList.toggle('on', open)
  }

  const paintThemeIcon = () => {
    themeBtn.innerHTML = document.documentElement.dataset.theme === 'dark' ? icons.sun : icons.moon
  }
  paintThemeIcon()
  void (async () => {
    const s = await getSettings()
    if ((s.theme ?? 'system') === 'system') applyTheme('system')
  })()

  buildDataFoot(sideFoot)
  return { tabs, sidebar: sideTree, view, setSidebarOpen }
}

/** Bottom-left data strip: where the archive lives and how to move it. */
function buildDataFoot(foot: HTMLElement) {
  const row = (label: string, ic: string, fn: () => void, title = label) =>
    el('button', { class: 'foot-btn', type: 'button', title, html: `<span class="ic">${ic}</span><span>${label}</span>`, onclick: () => void fn() })
  const status = el('div', { class: 'foot-status' })
  const render = async () => {
    const handle = await loadFolderHandle()
    const notes = App.noteById.size
    status.replaceChildren(
      el('span', { class: 'foot-line' }, el('b', { text: handle ? `Archive: ${handle.name}` : 'Archive folder not set' })),
      el('span', { class: 'foot-sub', text: handle ? `${notes} note${notes === 1 ? '' : 's'} in this browser · folder kept in sync by Syncthing / OneDrive` : `${notes} note${notes === 1 ? '' : 's'} in this browser. Pick a folder to make Markdown files.` }),
    )
  }
  void render()
  App.onChange(() => void render())
  foot.replaceChildren(
    status,
    el(
      'div',
      { class: 'foot-actions' },
      row('Export to folder…', icons.download, exportToFolder, 'Write (or refresh) the Markdown archive folder'),
      row('Import', icons.upload, importFromFolder, 'Read a folder of Subject/Topic/Note.md files'),
      row('Sync now', icons.refresh, refreshFromFolder, 'Re-write files into the folder you picked before'),
      row('Backup', icons.folder, exportBackup, 'Download one JSON file with everything in it'),
    ),
    el('div', { class: 'foot-line2' },
      el('button', { class: 'foot-btn ghost', type: 'button', html: `<span class="ic">${icons.plus}</span><span>New subject</span>`, onclick: () => void newSubject() }),
    ),
  )
}

export const routeTitle = (route: Route) =>
  route.view === 'library'
    ? 'Link library · Notes'
    : route.view === 'books'
      ? 'Testi · Notes'
      : route.view === 'book'
        ? `${App.bookById.get(route.bookId)?.title ?? 'Libro'} · Notes`
    : route.view === 'all'
      ? 'Notes'
      : `${'subjectId' in route ? App.subjectById.get(route.subjectId)?.name ?? '' : ''} · Notes`
