/**
 * The whole data model. Three levels, on purpose: Subject > Topic > Note.
 * A note is an ordered list of blocks; each block is a small plain object so it
 * can be written straight to JSON or Markdown without translation.
 */

export type BlockType =
  | 'text'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'bulleted'
  | 'numbered'
  | 'todo'
  | 'toggle'
  | 'quote'
  | 'callout'
  | 'code'
  | 'divider'
  | 'image'
  | 'link'
  | 'ink'
  | 'page'

export interface Block {
  id: string
  type: BlockType
  /** HTML for editable text blocks (b/i/u/s/code/a survive inside). */
  content?: string
  /** Plain text for code blocks. */
  language?: string
  checked?: boolean
  /** Collapsed by default (toggle blocks). */
  collapsed?: boolean
  /** 0..4 */
  indent?: number
  /** image blocks */
  src?: string
  alt?: string
  caption?: string
  /** link blocks */
  url?: string
  label?: string
  note?: string
  kind?: 'video' | 'article' | 'paper' | 'doc' | 'link'
  starred?: boolean
  read?: boolean
  embed?: boolean
  addedAt?: number
  /** ink blocks: the drawing itself */
  strokes?: InkStroke[]
  /** page blocks: a pointer into an imported book */
  bookId?: string
  pageNumber?: number
  ink?: InkStroke[]
}

export type InkTool = 'pen' | 'highlight' | 'eraser'

/** One pen/highlighter stroke. Points are normalised (0..1) so the drawing
 *  scales with the pane instead of the pixels it was drawn on. */
export interface InkStroke {
  t: InkTool
  c: string
  w: number
  /** x, y, pressure triples in 0..1 space */
  d: number[]
}

export interface Book {
  id: string
  title: string
  author?: string
  subjectId?: string
  pageCount: number
  /** how the text layer was obtained */
  origin: 'pdf' | 'epub' | 'images' | 'manual'
  quality?: string
  textCoverage?: number
  createdAt: number
  updatedAt: number
}

export interface Page {
  id: string
  bookId: string
  n: number
  text: string
  /** data URL, optional on purpose: a text-only book is still useful */
  image?: string
  imageW?: number
  imageH?: number
  ink?: InkStroke[]
  ocr?: 'text' | 'ocr' | 'none'
}

export interface Subject {
  id: string
  name: string
  emoji: string
  /** Accent key from CORE_COLORS in ui/theme.ts. */
  color: string
  createdAt: number
  updatedAt: number
}

export interface Topic {
  id: string
  subjectId: string
  name: string
  emoji: string
  order: number
  createdAt: number
  updatedAt: number
}

export interface Note {
  id: string
  topicId: string
  title: string
  icon: string
  blocks: Block[]
  createdAt: number
  updatedAt: number
}

export interface Revision {
  id: string
  noteId: string
  at: number
  json: string
}

export interface Settings {
  theme?: 'light' | 'dark' | 'system'
  lastRoute?: string
  sidebar?: 'open' | 'closed'
  seeded?: boolean
}

export interface Vault {
  version: 1
  exportedAt: number
  subjects: Subject[]
  topics: Topic[]
  notes: Note[]
}

/** A folder tree as read from disk: subject folders > topic folders > .md files. */
export interface VaultTree {
  subjects: {
    name: string
    topics: { name: string; notes: { title: string; text: string }[] }[]
  }[]
}

export const isTextBlock = (b: Block) =>
  b.type !== 'divider' && b.type !== 'image' && b.type !== 'link' && b.type !== 'code'

/** A page the local model has already "studied" — its map, kept next to the book. */
export interface Digest {
  id: string
  bookId: string
  page: number
  at: number
  /** the four sections, as markdown */
  md: string
  keyIdeas: string[]
  definitions: string[]
  examQuestions: string[]
  links: string[]
  /** how much page text the digest was made from */
  chars: number
  error?: string
}

/** One screenshot -> notes run, kept so a crashed/aborted run is not lost. */
export interface ScanRun {
  id: string
  at: number
  effort: string
  imageCount: number
  usedVision?: boolean
  minutes?: number
  notes: string
  flashcards?: string
  extras?: string
  transcript?: string[]
  videos?: { title: string; url: string }[]
  bookId?: string
  error?: string
}
