#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startStandalone } from '../standalone/service.mjs'

const DEFAULT_FREE_MODEL_CANDIDATES = Object.freeze([
  // Start with the native OpenCode lane, then cross the provider boundary so
  // its per-session free limit cannot strand the public auto-router.
  'deepseek-v4.1-flash-free',
  'kilo-auto/free',
  'openrouter/free',
  // Keep a native fallback that exists in the runtime's offline bootstrap
  // catalog, and one concrete Kilo model behind its two automatic routers.
  'mimo-v2.6-flash-free',
  'nvidia/nemotron-3.5-lightning:free',
])

function apiKey(env) {
  const value = typeof env.OFM_API_KEY === 'string' ? env.OFM_API_KEY.trim() : ''
  if (value === '') throw new Error('OFM_API_KEY is required and must not be empty')
  return value
}

function port(env) {
  const value = env.OFM_PORT ?? '8080'
  if (!/^\d+$/.test(value) || Number(value) > 65535) {
    throw new Error('OFM_PORT must be an integer between 0 and 65535')
  }
  return Number(value)
}

function noRefresh(env) {
  const value = String(env.OFM_NO_REFRESH ?? '').trim().toLowerCase()
  if (value === '' || ['0', 'false', 'no', 'off'].includes(value)) return false
  if (['1', 'true', 'yes', 'on'].includes(value)) return true
  throw new Error('OFM_NO_REFRESH must be true/false, 1/0, yes/no, or on/off')
}

function freeModelCandidates(env) {
  const raw = typeof env.OFM_FREE_MODEL_CANDIDATES === 'string'
    ? env.OFM_FREE_MODEL_CANDIDATES.trim() : ''
  if (/^(?:0|false|no|none|off)$/i.test(raw)) return []
  const values = raw === '' ? DEFAULT_FREE_MODEL_CANDIDATES : raw.split(',').map(value => value.trim())
  const models = [...new Set(values.filter(Boolean))]
  if (models.length === 0 || models.length > 32 || models.some(id => id.length > 300 || /[\s,\u0000-\u001f\u007f]/.test(id))) {
    throw new Error('OFM_FREE_MODEL_CANDIDATES must be a comma-separated list of 1 to 32 model ids, or "off"')
  }
  return models
}

export function proxyOptions(env = process.env) {
  const candidates = freeModelCandidates(env)
  return {
    dataDir: path.resolve(env.OFM_DATA_DIR || '/data'),
    port: 0,
    refresh: !noRefresh(env),
    lanEnabled: true,
    lanPort: port(env),
    lanKey: apiKey(env),
    virtualModels: candidates.length === 0 ? [] : [{
      id: 'free-model',
      name: 'Free Model Auto Router',
      models: candidates,
      strategy: 'fallback',
      stickyLimit: 1,
      enabled: true,
    }],
  }
}

export async function runProxy({ env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  const service = await startStandalone(proxyOptions(env))
  try {
    await service.ready
  } catch (error) {
    await service.close()
    throw error
  }
  if (!service.lan.running) {
    const reason = service.lan.error ?? 'the inference relay did not start'
    await service.close()
    throw new Error(reason)
  }

  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    void service.close().catch(error => {
      stderr.write(`Proxy shutdown failed: ${error.message}\n`)
      process.exitCode = 1
    })
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)

  stdout.write([
    `${service.product} ${service.version} OpenAI proxy`,
    `Listening on 0.0.0.0:${service.lan.port}`,
    `Base URL: http://localhost:${service.lan.port}/v1`,
    `Data directory: ${service.dataDir}`,
    '',
  ].join('\n'))
  return service
}

const direct = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (direct) {
  runProxy().catch(error => {
    process.stderr.write(`Proxy startup failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
