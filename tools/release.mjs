// M11：把 dist/ 的发布产物同步到腾讯云 COS（CI 专用，SPEC §11）。
// 顺序固定：上传版本化二进制到 /dsh-desktop/<version>/<文件名>
//   → 回读验证 SHA-512 和大小
//   → 最后更新固定入口 /dsh-desktop/cn-stable.yml
// 只改路径不改哈希；任何一步失败立即退出（exit 1，CI 标红），保留 COS 上旧入口。
// 元数据文件（stable.yml）从构建元数据生成，禁止虚构哈希。
// 凭据只来自环境变量（CI Secrets）：COS_SECRET_ID / COS_SECRET_KEY / COS_BUCKET / COS_REGION。
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { createRequire } from 'node:module'
import { readFile, mkdtemp, rm, stat, mkdir } from 'node:fs/promises'
import { basename, join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const YAML = require('yaml')   // yaml 是 CJS 包；release.mjs 为 ESM，经 createRequire 加载

const COS_ROOT = 'dsh-desktop'                    // 不带前导斜杠（COS Key 约定）
const ENTRY_KEY = `${COS_ROOT}/cn-stable.yml`
/** 版本化二进制：不可变缓存；固定入口：no-cache。 */
const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable'
const ENTRY_CACHE = 'no-cache'

const REQUIRED_ENV = ['COS_SECRET_ID', 'COS_SECRET_KEY', 'COS_BUCKET', 'COS_REGION']

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 从 files[].url（可能是相对名或完整 URL）提取本地文件名。
 * @param {string} urlOrPath
 * @returns {string}
 */
export function fileNameOf(urlOrPath) {
  const noQuery = String(urlOrPath).split('?')[0]
  const seg = noQuery.split(/[\\/]/).filter(Boolean)
  const name = seg[seg.length - 1] ?? ''
  try { return decodeURIComponent(name) } catch (_) { return name }
}

/**
 * 依据 stable.yml 构建上传计划；本地缺失产物或缺哈希/大小时报错退出（不虚构）。
 * @param {{version:string, files?:Array<{url:string, sha512?:string, size?:number}>, path?:string}} doc
 * @param {string} version
 * @param {string} distDir
 * @returns {Promise<Array<{local:string, key:string, sha512:string, size:number}>>}
 */
export async function planUploads(doc, version, distDir) {
  if (!doc?.version) throw new Error('stable.yml 缺 version 字段')
  if (doc.version !== version) throw new Error(`stable.yml version(${doc.version}) 与 package.json version(${version}) 不一致`)
  const entries = doc.files?.length ? doc.files : [{ url: doc.path ?? '', sha512: doc.sha512, size: doc.size }]
  /** @type {Array<{local:string, key:string, sha512:string, size:number}>} */
  const plan = []
  const seen = new Set()
  for (const e of entries) {
    const name = fileNameOf(e.url ?? e.path)
    if (!name) throw new Error('stable.yml files[] 存在空 url')
    if (seen.has(name)) continue
    seen.add(name)
    const local = join(distDir, name)
    const st = await stat(local).catch(() => { throw new Error(`dist/ 缺失产物: ${name}`) })
    const sha512 = await hashFile(local)
    // 与构建元数据交叉核对，防止上传的不是构建器产出的那份。
    if (e.sha512 && e.sha512 !== sha512) throw new Error(`${name} 与 stable.yml 记录的 sha512 不一致`)
    if (e.size !== undefined && Number(e.size) !== st.size) throw new Error(`${name} 与 stable.yml 记录的 size 不一致`)
    plan.push({ local, key: `${COS_ROOT}/${version}/${name}`, sha512, size: st.size })
  }
  // blockmap 可能不在 files[] 里，但 electron-updater 差量更新需要，一并上传。
  for (const e of entries) {
    const exe = fileNameOf(e.url ?? e.path)
    if (!exe || seen.has(`${exe}.blockmap`)) continue
    const bm = join(distDir, `${exe}.blockmap`)
    if (await stat(bm).then(() => true, () => false)) {
      seen.add(`${exe}.blockmap`)
      plan.push({ local: bm, key: `${COS_ROOT}/${version}/${exe}.blockmap`, sha512: await hashFile(bm), size: (await stat(bm)).size })
    }
  }
  return plan
}

/**
 * 取本次构建的可溯源信息（官方做法）：CI 用 `GITHUB_SHA`；本地用 `git rev-parse HEAD` +
 * `git status --porcelain` 判断是否有未提交改动。**取不到就返回空对象**，绝不编造 commit。
 * @returns {{commit?:string, dirty?:boolean}}
 */
export function resolveBuildInfo() {
  /** @type {{commit?:string, dirty?:boolean}} */
  const out = {}
  let commit = process.env.GITHUB_SHA || ''
  try {
    if (!commit) commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim()
    out.dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', windowsHide: true }).trim().length > 0
  } catch {
    // 无 git 环境（或不在仓库里）：只保证 commit（若来自 CI），dirty 留空。
  }
  if (/^[0-9a-f]{7,40}$/i.test(commit)) out.commit = commit
  return out
}

/**
 * 由 stable.yml 派生 cn-stable.yml：files[].url / path（含顶层）改写为
 * `<version>/<文件名>` 的相对入口，哈希与大小原样保留（只改路径不改哈希）。
 * @param {{version:string, files?:Array<{url:string, sha512?:string, size?:number}>, path?:string, sha512?:string, size?:number, releaseDate?:string}} doc
 * @param {string} version
 * @param {{commit?:string, dirty?:boolean}} [buildInfo] 可溯源字段（取不到就不写，不编造）
 * @returns {Record<string, unknown>}
 */
export function buildCnStableDoc(doc, version, buildInfo = {}) {
  /** @type {Record<string, unknown>} */
  const out = JSON.parse(JSON.stringify(doc))
  // 可溯源字段（官方做法）：写进产物清单，出问题时能定位"这一版是从哪个提交构建的、工作区是否干净"。
  // ⚠ 这里的 commit 是**本壳仓库**的提交（我们不构建 dsh 本体，只绑定它）。
  // 取不到就不写这两个字段 —— 宁可缺字段，也不编造。
  if (typeof buildInfo.commit === 'string' && buildInfo.commit) out.dshBuildCommit = buildInfo.commit
  if (typeof buildInfo.dirty === 'boolean') out.dshBuildDirty = buildInfo.dirty
  if (Array.isArray(out.files)) {
    out.files = out.files.map(/** @returns {Record<string, unknown>} */ (f) => {
      const name = fileNameOf(/** @type {{url?:string}} */ (f).url ?? '')
      return { ...f, url: `${version}/${name}`, path: `${version}/${name}` }
    })
  }
  if (typeof out.path === 'string') out.path = `${version}/${fileNameOf(out.path)}`
  return out
}

/** @param {string} file @returns {Promise<string>} base64 摘要 */
async function hashFile(file) {
  const buf = await readFile(file)
  return createHash('sha512').update(buf).digest('base64')
}

async function main() {
  const missing = REQUIRED_ENV.filter(k => !process.env[k])
  if (missing.length) {
    console.error(`release: 缺少环境变量 ${missing.join(', ')}（应来自 CI Secrets）`)
    process.exit(1)
  }
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const distDir = join(root, 'dist')
  const stablePath = join(distDir, 'stable.yml')
  const stableRaw = await readFile(stablePath, 'utf8').catch(() => {
    throw new Error(`release: ${stablePath} 不存在（应由构建元数据生成后复制到 dist/）`)
  })
  const stableDoc = YAML.parse(stableRaw)
  const plan = await planUploads(stableDoc, version, distDir)
  if (!plan.length) throw new Error('release: 上传计划为空')

  const { default: COS } = await import('cos-nodejs-sdk-v5')
  const cos = new COS({
    SecretId: process.env.COS_SECRET_ID,
    SecretKey: process.env.COS_SECRET_KEY,
  })
  const bucket = { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION }

  // 1. 上传版本化二进制（不可变缓存语义）。
  for (const item of plan) {
    console.log(`release: 上传 ${item.key} (${item.size} bytes)`)
    await cos.uploadFile({ ...bucket, Key: item.key, FilePath: item.local, CacheControl: IMMUTABLE_CACHE })
  }

  // 2. 回读验证 SHA-512 与大小；任何不符立即失败，不进入第 3 步。
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-release-'))
  try {
    for (const item of plan) {
      const back = join(workDir, basename(item.key))
      await cos.getObject({ ...bucket, Key: item.key, Output: createWriteStream(back) })
      const sha512 = await hashFile(back)
      const st = await stat(back)
      if (sha512 !== item.sha512 || st.size !== item.size) {
        throw new Error(`回读校验失败: ${item.key} sha512/size 与上传不一致`)
      }
      console.log(`release: 回读校验通过 ${item.key}`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  // 3. 最后更新固定入口 cn-stable.yml（失败保留旧入口由本步之前 exit 保证）。
  const cnDoc = buildCnStableDoc(stableDoc, version, resolveBuildInfo())
  const cnYml = YAML.stringify(cnDoc)
  await mkdir(join(root, 'dist'), { recursive: true })
  await cos.putObject({ ...bucket, Key: ENTRY_KEY, Body: cnYml, CacheControl: ENTRY_CACHE })
  console.log(`release: 固定入口已更新 ${ENTRY_KEY} (Cache-Control: ${ENTRY_CACHE})`)
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (invokedAsScript) {
  main().catch(err => {
    console.error(`release: ${err?.message || err}`)
    process.exit(1)
  })
}
