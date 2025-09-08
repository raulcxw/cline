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

export interface SimplePortInfo {
	path: string // [核心修改] 將 'path' 改為 'port'，以匹配 serialport-lite 的輸出
}
