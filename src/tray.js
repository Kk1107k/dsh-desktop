// 托盘生命周期与菜单；调用注入的业务函数，不自行注册 IPC。
import { Tray, Menu, nativeImage, app } from 'electron'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
/** 包内素材根目录：按模块位置解析，不依赖进程工作目录（安装后 cwd 任意）。 */
const ASSETS_DIR = join(__dirname, '..', 'assets')

const STATE_ICON = {
  idle: 'tray.png',
  update: 'tray-update.png',
  running: 'tray-running.png',
}

/**
 * @param {{logger:import('./logger.js').Logger, onOpen:()=>void, onCheckUpdate:()=>void, getRunMode:()=>string, setRunMode:(m:string)=>void, onQuit:()=>void}} opts
 */
export function createTray({ logger, onOpen, onCheckUpdate, getRunMode, setRunMode, onQuit }) {
  const log = logger
  /** @type {import('electron').Tray|null} */ let tray = null
  /** @type {'idle'|'update'|'running'} */ let currentState = 'idle'
  let hasUpdate = false
  let hostHealthy = false
  /** @type {NodeJS.Timeout|null} */ let flashTimer = null

  const iconIdle = nativeImage.createFromPath(join(ASSETS_DIR, STATE_ICON.idle))
  const iconUpdate = nativeImage.createFromPath(join(ASSETS_DIR, STATE_ICON.update))
  const iconRunning = nativeImage.createFromPath(join(ASSETS_DIR, STATE_ICON.running))

  tray = new Tray(iconIdle)
  tray.setToolTip('DSH Desktop')

  function buildMenu() {
    /** @type {import('electron').MenuItemConstructorOptions[]} */
    const modes = [
      // SPEC §8：首版仅标准模式启用，其余三项显式禁用。enabled 写死而非常依赖 Electron 默认值。
      { label: '标准', type: 'radio', enabled: true, checked: getRunMode() === 'standard', click: () => setRunMode('standard') },
      { label: 'PTC', type: 'radio', checked: getRunMode() === 'ptc', enabled: false },
      { label: '极简', type: 'radio', checked: getRunMode() === 'minimal', enabled: false },
      { label: '创造', type: 'radio', checked: getRunMode() === 'creative', enabled: false },
    ]
    return Menu.buildFromTemplate([
      { label: '打开 DSH 桌面', click: onOpen },
      { label: '检查更新…', click: onCheckUpdate },
      { label: '运行模式', submenu: modes },
      { label: '设置', enabled: false },
      { type: 'separator' },
      { label: '退出 DSH Desktop', click: onQuit },
    ])
  }

  tray.setContextMenu(buildMenu())

  tray.on('double-click', () => onOpen())

  /**
   * 按 SPEC §8:264 的优先级推导徽章：update > running > idle。
   * 两个输入分开记，避免"后写者胜"——否则 host ready 会把新版本徽章冲掉，
   * 或更新结束后 host 明明健康却回不到绿色。§6:203「重启期间取消绿色」由 setHostHealthy(false) 自然成立。
   */
  function derive() {
    const next = hasUpdate ? 'update' : (hostHealthy ? 'running' : 'idle')
    if (currentState === next) return
    currentState = next
    if (next === 'update') tray?.setImage(iconUpdate)
    else if (next === 'running') tray?.setImage(iconRunning)
    else tray?.setImage(iconIdle)
  }

  /**
   * 设置徽章状态（更新侧来源）。'update' = 有新版本或正在下载；'idle' = 不再需要 update 徽章。
   * @param {'idle'|'update'|'running'} s
   */
  function setState(s) {
    if (s === 'update') hasUpdate = true
    else if (s === 'running') hostHealthy = true
    else hasUpdate = false
    derive()
  }

  /** host 健康度输入：ready 置 true，失联/停止/重启期间置 false。 */
  function setHostHealthy(v) {
    hostHealthy = !!v
    derive()
  }

  function getState() { return currentState }

  /**
   * 闪现文字反馈（"已检查更新" 5s），不覆盖更高优先级徽章。
   * @param {string} text
   * @param {number} [ms]
   */
  function setFlashText(text, ms = 5000) {
    tray?.setToolTip(text)
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { tray?.setToolTip('DSH Desktop') }, ms)
  }

  function destroy() {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null }
    tray?.destroy()
    tray = null
  }

  return { setState, setHostHealthy, getState, setFlashText, destroy }
}