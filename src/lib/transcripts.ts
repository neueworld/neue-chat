import Airtable from 'airtable'

export interface TranscriptMessage {
  role: 'user' | 'assistant'
  content: string
}

export async function saveTranscript(sessionId: string, messages: TranscriptMessage[]) {
  if (!sessionId || messages.length === 0) return

  if (!process.env.AIRTABLE_API_KEY || !process.env.AIRTABLE_BASE_ID) {
    console.warn('Airtable not configured — transcript not saved')
    return
  }

  const base = new Airtable({ apiKey: process.env.AIRTABLE_API_KEY })
    .base(process.env.AIRTABLE_BASE_ID)

  const table = base(process.env.AIRTABLE_TRANSCRIPTS_TABLE || 'Transcripts')

  const transcript = messages
    .map(m => `[${m.role.toUpperCase()}]\n${m.content}`)
    .join('\n\n---\n\n')

  const now = new Date().toISOString()
  const safeId = sessionId.replace(/'/g, "\\'")

  try {
    const existing = await table
      .select({
        filterByFormula: `{Session ID} = '${safeId}'`,
        maxRecords: 1,
      })
      .firstPage()

    const fields = {
      'Session ID': sessionId,
      Transcript: transcript,
      'Message Count': messages.length,
      'Updated At': now,
    }

    if (existing.length > 0) {
      await table.update([{ id: existing[0].id, fields }], { typecast: true })
    } else {
      await table.create([{ fields: { ...fields, 'Started At': now } }], { typecast: true })
    }
  } catch (err) {
    console.error('Failed to save transcript:', err)
  }
}
