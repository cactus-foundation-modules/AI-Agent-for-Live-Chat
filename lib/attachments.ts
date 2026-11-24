// ---------------------------------------------------------------------------
// The files a visitor sends, as the assistant sees them.
//
// The model reads pictures and PDFs (owner's decision): a photograph of a
// split desk top, a screenshot of a basket, a PDF floor plan. They go to the
// Responses API as content parts in the visitor's own message - a picture as
// `input_image` with a data URL, a PDF as `input_file` with its name and a
// base64 data URL - so the model sees each where it was sent.
//
// Only the visitor's files, and only a few: the newest MAX_FILES_TO_MODEL of
// the chat, each within Live Chat's own size limit. Anything else (a Word
// file, a zip, an older picture) is a short line of text instead, so the model
// knows something was sent and that a colleague should look.
//
// The pictures also go into a damage report raised from the chat
// (lib/order-request.ts), as long as they are a kind the shop takes there.
//
// Pure: lists in, decisions and parts out. The bytes are read by the turn
// runner with Live Chat's readResponderAttachment.
// ---------------------------------------------------------------------------

/** Files the model is shown in one turn, newest first. */
export const MAX_FILES_TO_MODEL = 4
/** Live Chat's own per-file limit (its MAX_ATTACHMENT_BYTES), restated rather
 *  than imported so this file stays free of Live Chat's code. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024
/** Pictures OpenAI reads. */
export const MODEL_IMAGE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp', 'image/gif']
export const PDF_TYPE = 'application/pdf'
/** Pictures the shop takes on a damage report (its issue-photos PHOTO_TYPES). */
export const REPORT_PHOTO_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp']
/** Photographs on one damage report: the shop's MAX_DAMAGE_PHOTOS. */
export const MAX_REPORT_PHOTOS = 6

export type FileRef = { id: string; filename: string; contentType: string; sizeBytes: number }

/** An attachment as a chat message carries it. Older callers may know only
 *  the name. */
export type AttachmentLike = { id?: string; filename: string; contentType?: string; sizeBytes?: number }

export type FileLine = { id: number; sender: string; attachments: ReadonlyArray<AttachmentLike> }

export type ContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail: 'auto' }
  | { type: 'input_file'; filename: string; file_data: string }

/** A file read and ready for the model, keyed by attachment id. */
export type LoadedFile = { kind: 'image' | 'pdf'; filename: string; dataUrl: string }

function full(a: AttachmentLike): FileRef | null {
  if (!a.id || !a.contentType || typeof a.sizeBytes !== 'number') return null
  return { id: a.id, filename: a.filename, contentType: a.contentType.toLowerCase(), sizeBytes: a.sizeBytes }
}

export function modelCanRead(file: Pick<FileRef, 'contentType' | 'sizeBytes'>): boolean {
  const type = file.contentType.toLowerCase()
  return (MODEL_IMAGE_TYPES.includes(type) || type === PDF_TYPE) && file.sizeBytes > 0 && file.sizeBytes <= MAX_FILE_BYTES
}

/** Every file the visitor sent up to `upToId`, newest first. */
export function visitorFiles(messages: readonly FileLine[], upToId: number): FileRef[] {
  const out: FileRef[] = []
  for (const line of messages) {
    if (line.id > upToId || line.sender !== 'visitor') continue
    for (const attachment of line.attachments) {
      const file = full(attachment)
      if (file) out.push(file)
    }
  }
  return out.reverse()
}

/** The files to read and show the model this turn: the newest it can read,
 *  MAX_FILES_TO_MODEL at most. */
export function filesForModel(messages: readonly FileLine[], upToId: number, max: number = MAX_FILES_TO_MODEL): FileRef[] {
  return visitorFiles(messages, upToId).filter(modelCanRead).slice(0, max)
}

/** The pictures that can go into a damage report, newest first. */
export function photosForReport(messages: readonly FileLine[], upToId: number, max: number = MAX_REPORT_PHOTOS): FileRef[] {
  return visitorFiles(messages, upToId)
    .filter((file) => REPORT_PHOTO_TYPES.includes(file.contentType) && file.sizeBytes > 0 && file.sizeBytes <= MAX_FILE_BYTES)
    .slice(0, max)
}

/** The bytes of a file, as the part the model reads. */
export function loadedFile(file: Pick<FileRef, 'filename' | 'contentType'>, content: Uint8Array): LoadedFile {
  const type = file.contentType.toLowerCase()
  const base64 = Buffer.from(content).toString('base64')
  return {
    kind: type === PDF_TYPE ? 'pdf' : 'image',
    filename: file.filename || (type === PDF_TYPE ? 'document.pdf' : 'picture'),
    dataUrl: `data:${type};base64,${base64}`,
  }
}

export function contentPart(file: LoadedFile): ContentPart {
  return file.kind === 'pdf'
    ? { type: 'input_file', filename: file.filename, file_data: file.dataUrl }
    : { type: 'input_image', image_url: file.dataUrl, detail: 'auto' }
}

/** The line that stands in for a file the model is not shown, saying why. */
export function fileNote(attachment: AttachmentLike): string {
  const name = attachment.filename || 'a file'
  const file = full(attachment)
  if (!file) return `[Sent a file: ${name}]`
  const type = file.contentType
  if (!MODEL_IMAGE_TYPES.includes(type) && type !== PDF_TYPE) {
    return `[Sent a file you cannot open here: ${name}. A colleague should look at it.]`
  }
  if (file.sizeBytes > MAX_FILE_BYTES) return `[Sent a file too large for you to open: ${name}. A colleague should look at it.]`
  return `[Sent ${type === PDF_TYPE ? 'a PDF' : 'a picture'}: ${name}. Not shown to you: only the newest ${MAX_FILES_TO_MODEL} files are.]`
}
