// 验收测试专用的模块解析钩子（node:module register）。
// 把 'electron' 与 'electron-updater' 指向 tests/stubs/ 下的可控假件，
// 其余说明符原样放行。只在测试进程内生效，不进入任何发布产物。
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'electron') {
    return { url: new URL('./electron.mjs', import.meta.url).href, shortCircuit: true }
  }
  if (specifier === 'electron-updater') {
    return { url: new URL('./electron-updater.mjs', import.meta.url).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
