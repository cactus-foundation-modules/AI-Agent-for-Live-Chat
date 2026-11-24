import { describe, expect, it } from 'vitest'
import {
  MAX_FILE_BYTES,
  MAX_FILES_TO_MODEL,
  contentPart,
  fileNote,
  filesForModel,
  loadedFile,
  photosForReport,
  visitorFiles,
  type FileLine,
} from './attachments'
import { AUTHOR_ID } from './constants'
import { transcriptInput, type TranscriptLine } from './model-input'

const file = (id: string, contentType: string, sizeBytes = 1000, filename = `${id}.bin`) => ({ id: id.padEnd(32, '0'), filename, contentType, sizeBytes })

function line(id: number, sender: FileLine['sender'], attachments: ReturnType<typeof file>[]): TranscriptLine {
  return { id, sender: sender as TranscriptLine['sender'], authorId: sender === 'agent' ? AUTHOR_ID : null, authorName: null, body: `message ${id}`, attachments }
}

describe('which files the model is shown', () => {
  const chat = [
    line(1, 'visitor', [file('a', 'image/jpeg'), file('b', 'application/pdf')]),
    line(2, 'agent', [file('c', 'image/png')]),
    line(3, 'visitor', [file('d', 'application/zip'), file('e', 'image/png', MAX_FILE_BYTES + 1)]),
    line(4, 'visitor', [file('f', 'image/webp'), file('g', 'image/gif'), file('h', 'image/png')]),
    line(5, 'visitor', [file('i', 'image/jpeg')]),
  ]

  it('takes only the visitor\'s files, newest first, up to the message being answered', () => {
    expect(visitorFiles(chat, 4).map((f) => f.id[0])).toEqual(['h', 'g', 'f', 'e', 'd', 'b', 'a'])
  })

  it('shows the model at most the newest four it can read, skipping other types and oversize files', () => {
    const picked = filesForModel(chat, 4)
    expect(picked).toHaveLength(MAX_FILES_TO_MODEL)
    expect(picked.map((f) => f.id[0])).toEqual(['h', 'g', 'f', 'b'])
  })

  it('puts only the kinds the shop takes into a damage report, six at most', () => {
    expect(photosForReport(chat, 5).map((f) => f.id[0])).toEqual(['i', 'h', 'f', 'a'])
    const many = Array.from({ length: 9 }, (_, i) => line(i + 1, 'visitor', [file(`p${i}`, 'image/jpeg')]))
    expect(photosForReport(many, 99)).toHaveLength(6)
  })

  it('says why a file was not shown', () => {
    expect(fileNote(file('d', 'application/zip', 10, 'stuff.zip'))).toMatch(/cannot open here: stuff\.zip\. A colleague should look/)
    expect(fileNote(file('e', 'image/png', MAX_FILE_BYTES + 1, 'big.png'))).toMatch(/too large/)
    expect(fileNote(file('a', 'image/jpeg', 10, 'old.jpg'))).toMatch(/only the newest 4/)
    expect(fileNote({ filename: 'legacy.jpg' })).toBe('[Sent a file: legacy.jpg]')
  })
})

describe('the parts the model reads', () => {
  it('sends a picture as input_image and a PDF as input_file, as base64 data URLs', () => {
    const picture = loadedFile({ filename: 'desk.jpg', contentType: 'image/jpeg' }, new Uint8Array([1, 2, 3]))
    expect(contentPart(picture)).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,AQID', detail: 'auto' })
    const pdf = loadedFile({ filename: 'plan.pdf', contentType: 'application/pdf' }, new Uint8Array([1, 2, 3]))
    expect(contentPart(pdf)).toEqual({ type: 'input_file', filename: 'plan.pdf', file_data: 'data:application/pdf;base64,AQID' })
  })

  it('puts read files into the visitor\'s own message, and notes the rest', () => {
    const a = file('a', 'image/jpeg', 10, 'split.jpg')
    const z = file('z', 'application/zip', 10, 'notes.zip')
    const loaded = new Map([[a.id, loadedFile(a, new Uint8Array([1]))]])
    const items = transcriptInput([line(1, 'visitor', [a, z])], 1, AUTHOR_ID, loaded)
    expect(items).toHaveLength(1)
    const content = items[0]!.content
    expect(Array.isArray(content)).toBe(true)
    if (Array.isArray(content)) {
      expect(content[0]).toMatchObject({ type: 'input_text' })
      expect((content[0] as { text: string }).text).toContain('notes.zip')
      expect(content[1]).toMatchObject({ type: 'input_image' })
    }
  })

  it('leaves a chat without files exactly as plain words', () => {
    expect(transcriptInput([line(1, 'visitor', [])], 1, AUTHOR_ID)).toEqual([{ role: 'user', content: 'message 1' }])
  })
})
