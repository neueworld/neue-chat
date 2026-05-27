import OpenAI from 'openai'
import { KNOWLEDGE_BASE } from '@/lib/knowledge'
import { saveLead } from '@/lib/leads'
import { saveTranscript, saveTranscriptJson } from '@/lib/transcripts'

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

const LEAD_RE = /<LEAD_CAPTURE>\s*([\s\S]*?)\s*<\/LEAD_CAPTURE>/

// Per-session token tracking (in-memory, resets on cold start — fine for MVP)
// ~4 chars per token; limit per session: 4000 tokens ≈ 16,000 chars
const SESSION_CHARS = new Map<string, number>()
const SESSION_CHAR_LIMIT = 16_000

// Per-session email tracking to prevent duplicate lead saves
const SESSION_CAPTURED_EMAILS = new Map<string, Set<string>>()

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g

export async function POST(req: Request) {
  const { messages, sessionId } = await req.json()

  if (!Array.isArray(messages) || messages.length === 0) {
    return Response.json({ error: 'messages array is required' }, { status: 400 })
  }

  // Token limit check
  const sessionKey = String(sessionId || 'anon')
  const usedChars = SESSION_CHARS.get(sessionKey) ?? 0
  if (usedChars >= SESSION_CHAR_LIMIT) {
    return Response.json({ limitReached: true }, { status: 429 })
  }

  const cleaned = messages.map((m: { role: string; content: string }) => ({
    role: m.role === 'assistant' ? 'assistant' as const : 'user' as const,
    content: String(m.content),
  }))

  // Count input chars toward session limit
  const inputChars = cleaned.reduce((n, m) => n + m.content.length, 0)
  SESSION_CHARS.set(sessionKey, usedChars + inputChars)

  // Auto-capture any email a user drops in their messages, regardless of model behavior
  const capturedEmails = SESSION_CAPTURED_EMAILS.get(sessionKey) ?? new Set<string>()
  SESSION_CAPTURED_EMAILS.set(sessionKey, capturedEmails)
  for (const msg of cleaned) {
    if (msg.role === 'user') {
      for (const email of msg.content.match(EMAIL_RE) ?? []) {
        if (!capturedEmails.has(email)) {
          capturedEmails.add(email)
          saveLead({ email, source: 'Direct', sessionId }).catch(e => console.error('auto lead capture error:', e))
        }
      }
    }
  }

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const completion = await client.chat.completions.create({
          model: 'gpt-4o',
          max_tokens: 600,
          stream: true,
          messages: [
            { role: 'system', content: KNOWLEDGE_BASE },
            ...cleaned,
          ],
        })

        let fullText = ''

        for await (const chunk of completion) {
          const text = chunk.choices[0]?.delta?.content
          if (text) {
            fullText += text
            SESSION_CHARS.set(sessionKey, (SESSION_CHARS.get(sessionKey) ?? 0) + text.length)
            controller.enqueue(encoder.encode(`data: ${JSON.stringify({ chunk: text })}\n\n`))
          }
        }

        // Parse and save lead from model output (source classification)
        const match = fullText.match(LEAD_RE)
        if (match) {
          try {
            const lead = JSON.parse(match[1])
            if (lead.email && !capturedEmails.has(lead.email)) {
              capturedEmails.add(lead.email)
              saveLead({ ...lead, source: lead.source || 'Intent', sessionId })
            }
          } catch { /* malformed JSON */ }
        }

        // Persist the full transcript (upsert by sessionId)
        if (sessionId) {
          const fullMessages = [...cleaned, { role: 'assistant' as const, content: fullText }]
          saveTranscript(String(sessionId), fullMessages)
            .catch(e => console.error('saveTranscript error:', e))
          saveTranscriptJson(String(sessionId), fullMessages)
            .catch(e => console.error('saveTranscriptJson error:', e))
        }

        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error'
        console.error('OpenAI error:', msg)
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Something went wrong. Please try again.' })}\n\n`))
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
