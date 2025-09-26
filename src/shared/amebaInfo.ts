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
	pw?: string
	port: number
}

export type LocalPortInfo = {
	path: string
}

export type RemotePortInfo = {
	path: string
	host: string // [修改] 使用 host 作為唯一標識
	serverName: string
	pw?: string
}

export type AmebaPortInfo = (LocalPortInfo | RemotePortInfo) & {
	isRemote: boolean
	serverName: string
	host: string
	pw?: string
}

export type AmebaExample = {
	/** 範例的最終名稱，例如 "mp3" */
	name: string
	/** 用於編譯的相對路徑，例如 "audio/mp3" 或 "ota" */
	path: string
	/** 如果是二級目錄，這裡會是父目錄的名稱，例如 "audio" */
	category?: string
}

export const EXAMPLE_LOGICAL_SEARCH_PATHS: { [key: string]: string[] } = {
	audio: ["component/audio/examples", "component/example/audio"],
	ui: ["component/ui/examples", "component/example/ui"],
	aivoice: ["component/aivoice/examples", "component/example/aivoice"],
	tflite_micro: ["component/tflite_micro/examples", "component/example/tflite_micro"],

	example: ["component/example"],
}
