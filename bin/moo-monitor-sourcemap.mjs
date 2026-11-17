#!/usr/bin/env node
/**
 * 手动 / CI 直传 sourcemap 到 Moo cloud(不经过云端字节)。
 *
 * 每个 .map 单独走一组三步(moo-scaffold-cloud 契约):
 *   1) POST {endpoint}/uploads/tickets   Bearer <sourcemaps CI token>
 *      { business:'sourcemaps', release, original_name, file_size, sha256, app?, build_id?, source_mode? }
 *   2) POST https://upload[-<region>].qiniup.com   multipart token,key,file
 *   3) POST {endpoint}/uploads/{upload_id}/confirm   Bearer, {}
 *
 * 有 Vite 插件时优先用 mooSourcemapUpload(它会自动注入 Debug ID);本脚本用于
 * 非 Vite 产物、补传、或独立 CI 步骤。用法见 README / docs/sourcemaps.md。
 */
import { readFile, readdir, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

function help() {
  return `Usage: moo-monitor-sourcemap [options]

Options:
  --endpoint <url>         Cloud API base, e.g. https://cloud.example.com/api/v1
                           (or env MOO_SOURCEMAP_ENDPOINT / MOO_MONITOR_ENDPOINT)
  --token <token>          Sourcemaps CI token (or env MOO_SOURCEMAP_TOKEN)
  --release <release>      Release name; defaults to moo-monitor-release rule from git
  --dir <path>             Directory to scan for .map files, default: dist
  --include <regex>        File filter regex, default: \\.js\\.map$
  --app <name>             Multi-app bucket (monorepo/legacy) for build-set isolation
  --build-id <id>          Override deterministic build id (default: hash of sorted names)
  --source-mode <mode>     context (default) or position (strip sourcesContent)
  --tag-prefix <prefix>    Tag prefix for release resolution, e.g. v
  --fetch-tags             git fetch <remote> --tags --force before resolving release
  --remote <name>          Remote for --fetch-tags, default: origin
  --delete-after-upload    Delete local .map files after all uploads succeeded
  --strict                 Fail fast on the first file error (always exits non-zero on failure)
  --silent                 Only print warnings/errors
  -h, --help               Show help
`
}

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') { out.help = true; continue }
    if (arg === '--fetch-tags') { out.fetchTags = true; continue }
    if (arg === '--delete-after-upload') { out.deleteAfterUpload = true; continue }
    if (arg === '--strict') { out.strict = true; continue }
    if (arg === '--silent') { out.silent = true; continue }
    if (!arg.startsWith('--')) throw new Error(`Unknown argument: ${arg}`)
    const key = arg.slice(2)
    const value = argv[i + 1]
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`)
    out[key] = value
    i++
  }
  return out
}

async function collectMaps(dir, include) {
  const found = []
  const walk = async (current) => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (include.test(entry.name)) found.push(full)
    }
  }
  await walk(dir)
  return found.sort()
}

/** position 模式:上传前剥离 sourcesContent(与 Vite 插件语义一致,源码不上云)。 */
function stripSourcesContent(bytes) {
  let map
  try { map = JSON.parse(bytes.toString('utf8')) } catch { return bytes }
  if (!map || typeof map !== 'object' || !('sourcesContent' in map)) return bytes
  delete map.sourcesContent
  return Buffer.from(JSON.stringify(map))
}

const opts = parseArgs(process.argv)
if (opts.help) { console.log(help()); process.exit(0) }

let mod
try {
  mod = await import('../dist/vite.js')
} catch {
  console.error('未找到 dist/vite.js —— 请先在仓库执行 npm run build。')
  process.exit(2)
}

const { uploadSourcemapFile, computeBuildId, SourcemapUploadError, resolveMooRelease } = mod

const endpoint = String(opts.endpoint || process.env.MOO_SOURCEMAP_ENDPOINT || process.env.MOO_MONITOR_ENDPOINT || '').replace(/\/+$/, '')
const token = String(opts.token || process.env.MOO_SOURCEMAP_TOKEN || '').trim()
const dir = resolve(String(opts.dir || 'dist'))
const include = new RegExp(String(opts.include || '\\.js\\.map$'))
const sourceMode = opts['source-mode'] === 'position' ? 'position' : 'context'
if (!endpoint) { console.error('缺少 --endpoint(或 MOO_SOURCEMAP_ENDPOINT / MOO_MONITOR_ENDPOINT)'); process.exit(2) }
if (!token) { console.error('缺少 --token(或 MOO_SOURCEMAP_TOKEN)'); process.exit(2) }

async function main() {
  const release = String(opts.release || '').trim()
    || await resolveMooRelease({ cwd: opts.cwd || process.cwd(), tagPrefix: opts['tag-prefix'], fetchTags: opts.fetchTags === true, remote: opts.remote })
  if (!release) { console.error('无法确定 release,请用 --release 指定'); process.exit(2) }

  const maps = await collectMaps(dir, include)
  if (maps.length === 0) { console.error(`在 ${dir} 未找到匹配 ${include} 的文件`); process.exit(2) }

  // basename 是云端匹配键:不同目录同名会互相覆盖/二义(与插件同口径,直接拒绝比错传安全)。
  const byBase = new Map()
  for (const full of maps) {
    const name = basename(full)
    if (byBase.has(name)) { console.error(`不同目录存在同名 map「${name}」,请调整产物名或收窄 --include`); process.exit(2) }
    byBase.set(name, full)
  }

  const names = maps.map((full) => basename(full))
  const buildId = String(opts['build-id'] || computeBuildId(names))
  const log = (msg) => { if (!opts.silent) console.log(`[moo-sourcemap] ${msg}`) }
  log(`release=${release} app=${opts.app || '-'} files=${maps.length} build_id=${buildId}`)

  let uploaded = 0
  const failures = []
  for (const full of maps) {
    const name = basename(full)
    let bytes = await readFile(full)
    if (sourceMode === 'position') bytes = stripSourcesContent(bytes)
    try {
      const result = await uploadSourcemapFile(
        { endpoint, token },
        { release, app: opts.app, buildId, sourceMode },
        name,
        bytes,
      )
      uploaded++
      log(`ok ${name}${result.reusedObject ? '(对象已存在,已复核)' : ''}`)
    } catch (e) {
      const message = e instanceof SourcemapUploadError ? e.message : e instanceof Error ? e.message : String(e)
      failures.push({ name, message })
      console.error(`[moo-sourcemap] ✗ ${name}: ${message}`)
      if (opts.strict) break // strict = 遇到首个失败立即停,不继续消耗票据/带宽
    }
  }

  if (opts.deleteAfterUpload && failures.length === 0) {
    for (const full of maps) await unlink(full).catch(() => {})
    log(`已从 ${dir} 删除 ${maps.length} 个 .map`)
  }
  log(`已上传并确认 ${uploaded}/${maps.length} 个 sourcemap(release ${release})`)
  if (failures.length > 0) {
    console.error(`[moo-sourcemap] ${failures.length} 个文件失败`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error('[moo-sourcemap] 上传失败:' + (e instanceof Error ? e.message : String(e)))
  process.exit(1)
})
