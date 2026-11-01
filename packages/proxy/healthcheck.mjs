const key = typeof process.env.OFM_API_KEY === 'string' ? process.env.OFM_API_KEY.trim() : ''
const port = process.env.OFM_PORT ?? '8080'

try {
  if (key === '') throw new Error('OFM_API_KEY is missing')
  const response = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const body = await response.json()
  if (body?.object !== 'list' || !Array.isArray(body.data)) throw new Error('invalid model response')
} catch (error) {
  process.stderr.write(`Health check failed: ${error.message}\n`)
  process.exitCode = 1
}
