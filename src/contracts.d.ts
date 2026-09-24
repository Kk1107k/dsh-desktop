/**
 * IPC 协议类型定义。runtime 为 JS + JSDoc，本文件仅用于编辑器类型辅助与契约快照。
 */
export type State = 'checking' | 'latest' | 'available' | 'downloading' | 'error'

export interface Empty {}

export interface StatusPayload { text: string }

export interface VersionData { version: string }

export interface AvailableData { version: string; notes: string }

export interface ProgressData { progress: number }

export interface ErrorData { message: string }

export type Snapshot =
  | { state: 'checking' }
  | ({ state: 'latest' } & VersionData)
  | ({ state: 'available' } & AvailableData)
  | ({ state: 'downloading' } & ProgressData)
  | ({ state: 'error' } & ErrorData)

export interface UpdateEvent { revision: number; snapshot: Snapshot }

export interface Bootstrap {
  version: string
  status: string
  finishRequested: boolean
  update: UpdateEvent
}

export type ErrorCode =
  | 'E_FORBIDDEN'
  | 'E_PAYLOAD'
  | 'E_INVALID_STATE'
  | 'E_BUSY'
  | 'E_IO'
  | 'E_UNPACKAGED'
  | 'E_INTERNAL'

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } }

export interface SplashAPI {
  onStatus(cb: (text: string) => void): void
  onFinish(cb: () => void): void
  getVersion(): string | undefined
  minimize(): Promise<Result<Empty>>
  close(): Promise<Result<Empty>>
}

export interface UpdateAPI {
  onState(cb: (state: State, data?: object) => void): void
  getState(): Snapshot | undefined
  startDownload(): Promise<Result<Empty>>
  retry(): Promise<Result<Empty>>
  close(): Promise<Result<Empty>>
  snooze(): Promise<Result<Empty>>
}

/** channel 名清单，需与 src/ipc.js CHANNELS 字段一致。 */
export type Channel =
  | 'dsh:bridge-ready'
  | 'dsh:splash-minimize'
  | 'dsh:splash-close'
  | 'dsh:check-update'
  | 'dsh:update-download'
  | 'dsh:update-snooze'
  | 'dsh:update-close'
  | 'dsh:splash-status'
  | 'dsh:splash-finish'
  | 'dsh:update-state'