/** Inline SVG icons (no icon font, no network). 1.6px stroke, rounded caps: the macOS SF look. */
const svg = (d: string, size = 16) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`

export const icons = {
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  plusSquare: svg('<path d="M6 3h12a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3z"/><path d="M12 9v6M9 12h6"/>'),
  sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  moon: svg('<path d="M20 13.6A8.2 8.2 0 1 1 10.4 4a6.6 6.6 0 0 0 9.6 9.6z"/>'),
  chevron: svg('<path d="M9 6l6 6-6 6"/>'),
  chevronDown: svg('<path d="M6 9l6 6 6-6"/>'),
  grid: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>'),
  book: svg('<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5z"/><path d="M4 5.5v15"/>'),
  link: svg('<path d="M10.5 13.5a4 4 0 0 0 5.7 0l2.8-2.8a4 4 0 0 0-5.7-5.7L11.9 6.4"/><path d="M13.5 10.5a4 4 0 0 0-5.7 0L5 13.3a4 4 0 0 0 5.7 5.7l1.4-1.4"/>'),
  play: svg('<path d="M8 5.5l10 6.5-10 6.5z"/>', 14),
  star: svg('<path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.8l5.9-.9z"/>'),
  trash: svg('<path d="M4 7h16M9 7V4.5h6V7M6.5 7l.8 12.2A1.8 1.8 0 0 0 9.1 21h5.8a1.8 1.8 0 0 0 1.8-1.8L17.5 7"/>'),
  dots: svg('<circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none"/>'),
  grip: svg('<circle cx="9" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="12" r="1.3" fill="currentColor" stroke="none"/><circle cx="9" cy="18" r="1.3" fill="currentColor" stroke="none"/><circle cx="15" cy="18" r="1.3" fill="currentColor" stroke="none"/>', 14),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  folder: svg('<path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.7l1.8 2.2h7.5a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>'),
  download: svg('<path d="M12 4v11m0 0l-4-4m4 4l4-4"/><path d="M4.5 19h15"/>'),
  upload: svg('<path d="M12 20V9m0 0L8 13m4-4l4 4"/><path d="M4.5 5h15"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 6.3"/><path d="M20 5v6h-6"/>'),
  image: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.2"/><circle cx="9" cy="10" r="1.6"/><path d="M20.5 15.5l-4.3-4.2a2 2 0 0 0-2.8 0L4.5 20"/>'),
  check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  history: svg('<path d="M3.5 12a8.5 8.5 0 1 0 8.5-8.5A8.4 8.4 0 0 0 6 5.6"/><path d="M3.5 4v4h4"/><path d="M12 8v4.5l3 1.8"/>'),
  menu: svg('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  external: svg('<path d="M14 4h6v6"/><path d="M20 4l-8.5 8.5"/><path d="M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/>'),
  clock: svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 1.8"/>'),
} as const

export type IconName = keyof typeof icons

export const icon = (name: IconName, cls = '') => `<span class="ic ${cls}">${icons[name]}</span>`
