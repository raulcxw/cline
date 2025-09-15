export interface AmebaRemoteSerialPortServerConfig {
	host: string
	port: number
	username?: string
	password?: string
	timeout?: number
	[key: string]: any // 允许其他自定义配置
}

export interface AmebaRemoteServer {
	name: string
	host: string
	port: number
}

export type LocalPortInfo = {
	path: string
}

export type RemotePortInfo = {
	path: string
	host: string // [修改] 使用 host 作為唯一標識
	serverName: string
}

export type AmebaPortInfo = (LocalPortInfo | RemotePortInfo) & {
	isRemote: boolean
	serverName: string
	host: string
}

export type AmebaExample = {
	/** 範例的最終名稱，例如 "mp3" */
	name: string
	/** 用於編譯的相對路徑，例如 "audio/mp3" 或 "ota" */
	path: string
	/** 如果是二級目錄，這裡會是父目錄的名稱，例如 "audio" */
	category?: string
}
