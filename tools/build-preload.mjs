// M11：将 src/preload.js 打包为 build/preload.cjs。
// package.json 是 ESM，而 sandbox preload 必须以 CJS 加载（源码里用了 require('electron')），
// 不打包直接引用会在运行时崩。仅 external electron，其余全部内联。
import { build } from 'esbuild'
import { mkdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entry = resolve(root, 'src', 'preload.js')
const outfile = resolve(root, 'build', 'preload.cjs')

mkdirSync(dirname(outfile), { recursive: true })

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  // preload 以 CJS 加载：源文件末尾的 `export {}` 由 esbuild 转译，不会报错。
  format: 'cjs',
  platform: 'node',
  target: 'node22',
  external: ['electron'],
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'silent',
  write: true,
})

if (result.errors.length > 0) {
  for (const e of result.errors) console.error(e.text)
  process.exit(1)
}

console.log(`build/preload.cjs <- src/preload.js (${statSync(outfile).size} bytes)`)
