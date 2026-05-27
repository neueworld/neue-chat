import Airtable from 'airtable'

export async function GET() {
  const key = process.env.AIRTABLE_API_KEY
  const base = process.env.AIRTABLE_BASE_ID
  const table = process.env.AIRTABLE_TABLE_NAME

  if (!key || !base) {
    return Response.json({ error: 'Airtable env vars not set', key: !!key, base: !!base, table })
  }

  try {
    await new Airtable({ apiKey: key }).base(base)(table || 'neue-leads').create([{
      fields: {
        Name: 'Debug Test',
        Email: 'debug@test.com',
        Source: 'Debug',
        'Session ID': 'debug-001',
        'Captured At': new Date().toISOString().split('T')[0],
      },
    }])
    return Response.json({ ok: true, base, table, keyPrefix: key.slice(0, 10) })
  } catch (err: unknown) {
    const e = err as { message?: string; statusCode?: number; error?: string }
    return Response.json({ ok: false, error: e.message, code: e.error, status: e.statusCode, base, table, keyPrefix: key.slice(0, 10) })
  }
}
