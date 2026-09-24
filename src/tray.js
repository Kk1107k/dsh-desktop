// 托盘生命周期与菜单；调用注入的业务函数，不自行注册 IPC。
import { Tray, Menu, nativeImage, app } from 'electron'
import { join } from 'node:path'

const STATE_ICON = {
  idle: 'assets/tray.png',
  update: 'assets/tray-update.png',
  running: 'assets/tray-running.png',
}

/**
 * @param {{logger:object, onOpen:()=>void, onCheckUpdate:()=>void, getRunMode:()=>string, setRunMode:(m:string)=>void, onQuit:()=>void}} opts
 */
export function createTray({ logger, onOpen, onCheckUpdate, getRunMode, setRunMode, onQuit }) {
  const log = logger
  let tray = null
  let currentState = 'idle'
  let flashTimer = null

  const iconIdle = nativeImage.createFromPath(join(process.cwd(), 'assets', 'tray.png'))
  const iconUpdate = nativeImage.createFromPath(join(process.cwd(), 'assets', 'tray-update.png'))
  const iconRunning = nativeImage.createFromPath(join(process.cwd(), 'assets', 'tray-running.png'))

  tray = new Tray(iconIdle)
  tray.setToolTip('DSH Desktop')

  function buildMenu() {
    const modes = [
      { label: '标准', type: 'radio', checked: getRunMode() === 'standard', click: () => setRunMode('standard') },
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
   * 设置徽章状态。优先级：update > running > idle。
   * @param {'idle'|'update'|'running'} s
   */
  function setState(s) {
    if (currentState === s) return
    currentState = s
    if (s === 'update') tray.setImage(iconUpdate)
    else if (s === 'running') tray.setImage(iconRunning)
    else tray.setImage(iconIdle)
  }

  function getState() { return currentState }

  /**
   * 闪现文字反馈（"已检查更新" 5s），不覆盖更高优先级徽章。
   * @param {string} text
   * @param {number} ms
   */
  function setFlashText(text, ms = 5000) {
    tray.setToolTip(text)
    if (flashTimer) clearTimeout(flashTimer)
    flashTimer = setTimeout(() => { tray.setToolTip('DSH Desktop') }, ms)
  }

  function destroy() {
    if (flashTimer) { clearTimeout(flashTimer); flashTimer = null }
    tray?.destroy()
    tray = null
  }

  return { setState, getState, setFlashText, destroy }
}