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
