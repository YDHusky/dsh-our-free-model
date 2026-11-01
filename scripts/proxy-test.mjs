import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-proxy-'))
const model = 'mimo-v2.6-flash-free'
const kiloModel = 'kilo-auto/free'
const publicKey = 'proxy-public-test-key'
let streamGate
let freeRateLimited = false
let kiloRateLimited = false
const frame = value => `data: ${JSON.stringify(value)}\n\n`
const upstream = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ data: req.url === '/models'
        ? [{ id: kiloModel, name: 'Kilo Auto (free)', isFree: true }]
        : [{ id: model }] }))
      return
    }
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}')
    const kilo = req.url === '/chat/completions' && body.model === kiloModel
    const free = req.url.startsWith('/inference/') && body.model === model
    if ((free && freeRateLimited) || (kilo && kiloRateLimited)) {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '3' })
      res.end(JSON.stringify({ error: { message: 'fixture free usage limit reached', type: 'rate_limit_error', code: 'RATE_LIMIT' } }))
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(frame({ choices: [{ index: 0, delta: { content: kilo ? 'KILO FALLBACK OK' : 'PROXY OK' } }] }))
    const finish = () => res.end(frame({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }) + 'data: [DONE]\n\n')
    if (streamGate) void streamGate.then(finish)
    else finish()
  })
})
await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve))
const upstreamUrl = `http://127.0.0.1:${upstream.address().port}`
process.env.OUR_FREE_MODEL_BASE = upstreamUrl
process.env.OUR_FREE_MODEL_KILO_BASE = upstreamUrl

const { startStandalone } = await import('../packages/standalone/service.mjs')
const { proxyOptions } = await import('../packages/proxy/cli.mjs')

let service
let failures = 0
let checks = 0
const check = async (name, run) => {
  checks++
  try {
    await run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures++
    console.error(`FAIL ${name}: ${error.stack}`)
  }
}
const settings = directory => JSON.parse(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'))
const relayUrl = () => `http://127.0.0.1:${service.lan.port}`
const request = async (route, { key = publicKey, body, method, headers = {} } = {}) => {
  const response = await fetch(relayUrl() + route, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: {
      connection: 'close',
      ...key ? { authorization: `Bearer ${key}` } : {},
      ...body === undefined ? {} : { 'content-type': 'application/json' },
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  const text = await response.text()
  let value
  try { value = JSON.parse(text) } catch { value = text }
  return { status: response.status, headers: response.headers, text, value }
}
async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}
async function assertPortReleased(port) {
  const server = net.createServer()
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
}
async function waitForReady(child, output) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`proxy child timed out\n${output()}`)), 15000)
    const inspect = () => {
      if (!output().includes('Listening on 0.0.0.0:')) return
      clearTimeout(timer)
      child.stdout.off('data', inspect)
      resolve()
    }
    child.stdout.on('data', inspect)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      reject(new Error(`proxy child exited before ready (${code ?? signal})\n${output()}`))
    })
  })
}

try {
  await check('proxy environment requires a key and validates port and refresh values', () => {
    assert.throws(() => proxyOptions({}), /OFM_API_KEY/)
    assert.throws(() => proxyOptions({ OFM_API_KEY: 'key', OFM_PORT: '65536' }), /OFM_PORT/)
    assert.throws(() => proxyOptions({ OFM_API_KEY: 'key', OFM_NO_REFRESH: 'sometimes' }), /OFM_NO_REFRESH/)
    assert.throws(() => proxyOptions({ OFM_API_KEY: 'key', OFM_FREE_MODEL_CANDIDATES: 'one, bad id' }), /OFM_FREE_MODEL_CANDIDATES/)
    const options = proxyOptions({
      OFM_API_KEY: ' key ', OFM_PORT: '8123', OFM_DATA_DIR: './fixture', OFM_NO_REFRESH: 'yes',
    })
    const { virtualModels, ...base } = options
    assert.deepEqual(base, {
      dataDir: path.resolve('./fixture'), port: 0, refresh: false,
      lanEnabled: true, lanPort: 8123, lanKey: 'key',
    })
    assert.equal(virtualModels.length, 1)
    assert.equal(virtualModels[0].id, 'free-model')
    assert.ok(virtualModels[0].models.includes(kiloModel))
    assert.deepEqual(proxyOptions({ OFM_API_KEY: 'key', OFM_FREE_MODEL_CANDIDATES: 'off' }).virtualModels, [])
    assert.deepEqual(
      proxyOptions({ OFM_API_KEY: 'key', OFM_FREE_MODEL_CANDIDATES: `${model},${kiloModel},${model}` }).virtualModels[0].models,
      [model, kiloModel],
    )
  })

  await check('programmatic LAN key validation happens before data is created', async () => {
    const invalid = path.join(scratch, 'invalid')
    for (const lanKey of ['', '   ', 123]) {
      await assert.rejects(startStandalone({ dataDir: invalid, lanKey }), /lanKey/)
    }
    assert.equal(fs.existsSync(invalid), false)
  })

  const dataDir = path.join(scratch, 'data')
  service = await startStandalone({
    dataDir, port: 0, refresh: false, lanEnabled: true, lanPort: 0, lanKey: publicKey,
    virtualModels: [{ id: 'free-model', name: 'Free Model Auto Router', models: [model, kiloModel], strategy: 'fallback' }],
    logger: { warn() {} },
  })
  await service.ready
  await service.runtime.refreshCatalog({ probe: false })

  await check('fixed public key is persisted apart from the loopback key', () => {
    const saved = settings(dataDir)
    assert.equal(saved.standaloneLanKey, publicKey)
    assert.notEqual(saved.forwardKey, publicKey)
    assert.equal(service.lan.enabled, true)
    assert.equal(service.lan.running, true)
  })

  await check('relay enforces authentication and never exposes management routes', async () => {
    assert.equal((await request('/v1/models', { key: '' })).status, 401)
    assert.equal((await request('/v1/models', { key: 'wrong' })).status, 401)
    const models = await request('/v1/models')
    assert.equal(models.status, 200)
    assert.ok(models.value.data.some(row => row.id === model))
    assert.ok(models.value.data.some(row => row.id === 'free-model'))
    for (const route of ['/', '/health', '/api/management/summary', '/api/management/key']) {
      assert.equal((await request(route)).status, 404, route)
    }
  })

  await check('OpenAI Chat Completions and Responses use the project runtime', async () => {
    const chat = await request('/v1/chat/completions', {
      body: { model, messages: [{ role: 'user', content: 'ping' }] },
    })
    assert.equal(chat.status, 200, chat.text)
    assert.equal(chat.value.choices[0].message.content, 'PROXY OK')
    const responses = await request('/v1/responses', { body: { model, input: 'ping' } })
    assert.equal(responses.status, 200, responses.text)
    assert.ok(JSON.stringify(responses.value.output).includes('PROXY OK'))
  })

  await check('free-model crosses providers and works through four client protocol styles', async () => {
    freeRateLimited = true
    try {
      const chat = await request('/v1/chat/completions', {
        body: { model: 'free-model', messages: [{ role: 'user', content: 'ping' }] },
      })
      assert.equal(chat.status, 200, chat.text)
      assert.equal(chat.value.choices[0].message.content, 'KILO FALLBACK OK')

      const responses = await request('/v1/responses', { body: { model: 'free-model', input: 'ping' } })
      assert.equal(responses.status, 200, responses.text)
      assert.ok(JSON.stringify(responses.value.output).includes('KILO FALLBACK OK'))

      const messages = await request('/v1/messages', {
        body: { model: 'free-model', max_tokens: 64, messages: [{ role: 'user', content: 'ping' }] },
        headers: { 'anthropic-version': '2023-06-01' },
      })
      assert.equal(messages.status, 200, messages.text)
      assert.ok(JSON.stringify(messages.value.content).includes('KILO FALLBACK OK'))

      const geminiModels = await request('/v1beta/models', {
        key: '', headers: { 'x-goog-api-key': publicKey }, method: 'GET',
      })
      assert.equal(geminiModels.status, 200, geminiModels.text)
      assert.ok(geminiModels.value.models.some(row => row.name === 'models/free-model'))
      const gemini = await request('/v1beta/models/free-model:generateContent', {
        key: '', headers: { 'x-goog-api-key': publicKey },
        body: { contents: [{ role: 'user', parts: [{ text: 'ping' }] }] },
      })
      assert.equal(gemini.status, 200, gemini.text)
      assert.ok(JSON.stringify(gemini.value.candidates).includes('KILO FALLBACK OK'))

      kiloRateLimited = true
      const limited = await request('/v1/chat/completions', {
        body: { model: 'free-model', messages: [{ role: 'user', content: 'ping' }] },
      })
      assert.equal(limited.status, 429, limited.text)
      assert.equal(limited.value.error.code, 'RATE_LIMIT')
    } finally {
      freeRateLimited = false
      kiloRateLimited = false
    }
  })

  await check('streaming reaches the client before the upstream response ends', async () => {
    let finish
    streamGate = new Promise(resolve => { finish = resolve })
    try {
      const response = await fetch(relayUrl() + '/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: `Bearer ${publicKey}`, 'content-type': 'application/json', connection: 'close' },
        body: JSON.stringify({ model, stream: true, messages: [{ role: 'user', content: 'ping' }] }),
        signal: AbortSignal.timeout(10000),
      })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type'), /text\/event-stream/)
      const reader = response.body.getReader()
      let start = ''
      while (!start.includes('PROXY OK')) {
        const chunk = await reader.read()
        assert.equal(chunk.done, false)
        start += Buffer.from(chunk.value).toString()
      }
      assert.ok(!start.includes('[DONE]'))
      finish()
      let tail = ''
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        tail += Buffer.from(chunk.value).toString()
      }
      assert.match(tail, /\[DONE\]/)
    } finally {
      finish?.()
      streamGate = undefined
    }
  })

  await service.close()
  service = undefined
  const beforeRestart = settings(dataDir)
  service = await startStandalone({
    dataDir, port: 0, refresh: false, lanEnabled: true, lanPort: 0, lanKey: publicKey,
    virtualModels: [{ id: 'free-model', name: 'Free Model Auto Router', models: [model, kiloModel], strategy: 'fallback' }],
    logger: { warn() {} },
  })
  await check('restart preserves the fixed public key and private loopback key', () => {
    const afterRestart = settings(dataDir)
    assert.equal(afterRestart.standaloneLanKey, publicKey)
    assert.equal(afterRestart.forwardKey, beforeRestart.forwardKey)
    assert.ok(service.runtime.publicModelRows().some(row => row.id === 'free-model'))
    assert.ok(!afterRestart.combos.some(row => row.id === 'free-model'), 'product route must not overwrite saved combos')
  })
  await service.close()
  service = undefined

  await check('a supplied public key rotates an equal legacy loopback key', async () => {
    const directory = path.join(scratch, 'collision')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'settings.json'), JSON.stringify({
      forwardKey: publicKey, standaloneLanKey: 'old-public-key',
      standaloneLanEnabled: false, standaloneLanPort: 0,
    }))
    let isolated
    try {
      isolated = await startStandalone({
        dataDir: directory, port: 0, refresh: false,
        lanEnabled: true, lanPort: 0, lanKey: publicKey, logger: { warn() {} },
      })
      const saved = settings(directory)
      assert.equal(saved.standaloneLanKey, publicKey)
      assert.notEqual(saved.forwardKey, publicKey)
    } finally {
      await isolated?.close()
    }
  })

  await check('CLI starts from environment and SIGTERM releases its port and lock', async () => {
    const childData = path.join(scratch, 'child')
    const childPort = await availablePort()
    const childKey = 'child-proxy-key'
    const child = spawn(process.execPath, ['packages/proxy/cli.mjs'], {
      cwd: root,
      env: {
        ...process.env,
        OFM_API_KEY: childKey,
        OFM_PORT: String(childPort),
        OFM_DATA_DIR: childData,
        OFM_NO_REFRESH: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    let exited = false
    try {
      await waitForReady(child, () => stdout + stderr)
      const response = await fetch(`http://127.0.0.1:${childPort}/v1/models`, {
        headers: { authorization: `Bearer ${childKey}` },
        signal: AbortSignal.timeout(5000),
      })
      assert.equal(response.status, 200)
      child.kill('SIGTERM')
      const result = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('proxy child did not stop')), 10000)
        child.once('exit', (code, signal) => {
          clearTimeout(timer)
          exited = true
          resolve({ code, signal })
        })
      })
      assert.deepEqual(result, { code: 0, signal: null })
      assert.ok(!stdout.includes(childKey) && !stderr.includes(childKey))
      assert.equal(fs.existsSync(path.join(childData, 'service.lock')), false)
      await assertPortReleased(childPort)
    } finally {
      if (!exited) child.kill('SIGKILL')
    }
  })
} finally {
  await service?.close()
  upstream.closeAllConnections()
  await new Promise(resolve => upstream.close(resolve))
  const target = fs.realpathSync(scratch)
  const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep
  assert.ok(target.startsWith(tempRoot) && path.basename(target).startsWith('ofm-proxy-'))
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`proxy: ${checks - failures}/${checks} checks passed`)
process.exitCode = failures ? 1 : 0
