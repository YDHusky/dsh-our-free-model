import fs from 'node:fs'
import path from 'node:path'
import { standaloneSourceFiles, repositoryRoot } from './pack-standalone.mjs'

const destination = process.argv[2] && path.resolve(process.argv[2])
if (!destination) {
  console.error('usage: node scripts/build-proxy-image-context.mjs <destination>')
  process.exit(2)
}

if (fs.existsSync(destination) && fs.readdirSync(destination).length > 0) {
  throw new Error(`Destination is not empty: ${destination}`)
}
fs.mkdirSync(destination, { recursive: true })

const files = [...new Set([
  'package.json',
  'packages/proxy/cli.mjs',
  'packages/proxy/healthcheck.mjs',
  ...standaloneSourceFiles(),
])].sort()

let bytes = 0
for (const file of files) {
  const source = path.join(repositoryRoot, file)
  const relative = path.relative(repositoryRoot, source)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Source escapes the repository: ${file}`)
  }
  const stat = fs.lstatSync(source)
  if (!stat.isFile()) throw new Error(`Proxy image source is not a regular file: ${file}`)
  const target = path.join(destination, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL)
  fs.chmodSync(target, stat.mode & 0o777)
  bytes += stat.size
}

console.log(`Prepared proxy image context: ${files.length} files, ${bytes} bytes`)
