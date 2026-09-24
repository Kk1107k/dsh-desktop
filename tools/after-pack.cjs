// M11：electron-builder afterPack 钩子（CommonJS：electron-builder 以 require 加载）。
// 保留构建器生成的必要字段（如 updaterCacheDirName），把安装资源内 app-update.yml
// 的源字段规范化为国内兜底（SPEC §11）：
//   provider: generic / url: https://<占位 COS 域名>/dsh-desktop / channel: cn-stable
// 运行时 M08 仍显式构造 GitHub 主实例；此文件不是自动主备切换器。
'use strict'

const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')

const COS_PROVIDER = 'generic'
// 占位域名：公开发布前由 release 配置统一替换，禁止在源码里编造成真实域名。
const COS_URL = 'https://<占位 COS 域名>/dsh-desktop'
const COS_CHANNEL = 'cn-stable'
/** github 专属字段，切换到 generic 后不再有意义，规范化时移除。 */
const GITHUB_ONLY_FIELDS = ['owner', 'repo', 'releaseType']

/**
 * 规范化 app-update.yml 的源字段；保留其余构建器生成字段。
 * @param {string} ymlPath app-update.yml 绝对路径
 * @param {string} appOutDir 打包输出目录（日志用）
 */
function normalizeUpdateYml(ymlPath, appOutDir) {
  const raw = fs.readFileSync(ymlPath, 'utf8')
  const doc = YAML.parse(raw)
  if (!doc || typeof doc !== 'object') {
    throw new Error(`app-update.yml 内容不是映射: ${ymlPath}`)
  }
  doc.provider = COS_PROVIDER
  doc.url = COS_URL
  doc.channel = COS_CHANNEL
  for (const key of GITHUB_ONLY_FIELDS) delete doc[key]
  fs.writeFileSync(ymlPath, YAML.stringify(doc), 'utf8')
  return { provider: doc.provider, url: doc.url, channel: doc.channel, updaterCacheDirName: doc.updaterCacheDirName }
}

/**
 * electron-builder afterPack 钩子。
 * @param {{ appOutDir: string, electronPlatformName: string }} context
 */
module.exports = async function afterPack(context) {
  // 仅处理 Windows（本项目只出 NSIS）；其他平台直接跳过。
  if (context.electronPlatformName !== 'win32') return
  const ymlPath = path.join(context.appOutDir, 'resources', 'app-update.yml')
  if (!fs.existsSync(ymlPath)) {
    console.warn(`after-pack: ${ymlPath} 不存在，跳过规范化（dev/非发布构建）`)
    return
  }
  const normalized = normalizeUpdateYml(ymlPath, context.appOutDir)
  console.log(`after-pack: app-update.yml -> ${normalized.provider} ${normalized.url} channel=${normalized.channel}`)
}

module.exports.normalizeUpdateYml = normalizeUpdateYml
module.exports.COS_URL = COS_URL
module.exports.COS_CHANNEL = COS_CHANNEL
