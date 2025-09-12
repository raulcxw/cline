import * as net from "node:net"
import { AmebaRemoteServer, RemotePortInfo } from "@/shared/amebaInfo"

export type ServerConfigs = AmebaRemoteServer[]

export type TcpMessage = { type: "com_ports_update"; ports: string[] } | { type: "list_com_ports" }

export class AmebaRemoteSerialPort {
	private servers: ServerConfigs = []
	// [修改] 所有 Map 的鍵都改為 string (host)
	private tcpClients: Map<string, net.Socket> = new Map()
	private isConnected: Map<string, boolean> = new Map()
	private remotePorts: Map<string, RemotePortInfo[]> = new Map()
	private reconnectIntervals: Map<string, NodeJS.Timeout> = new Map()
	private onPortsChanged: () => void

	// [修改] 簡化構造函數
	constructor(onPortsChanged: () => void) {
		this.onPortsChanged = onPortsChanged
	}

	// [新增] 這是現在與外部溝通的主要方式
	public updateServerList(newServers: ServerConfigs): void {
		const newServerHosts = new Set(newServers.map((s) => s.host))
		const oldServerHosts = new Set(this.servers.map((s) => s.host))

		// 找出被刪除的伺服器並清理資源
		for (const host of oldServerHosts) {
			if (!newServerHosts.has(host)) {
				this.cleanupServerConnection(host)
			}
		}

		// 更新內部伺服器列表
		this.servers = newServers

		// 為新增或已存在的伺服器初始化或確認連線
		for (const server of this.servers) {
			if (!oldServerHosts.has(server.host)) {
				this.initTcpClient(server)
			}
		}

		// 在列表更新後，立即觸發一次端口合併通知
		this.onPortsChanged()
	}

	private initTcpClient(server: AmebaRemoteServer): void {
		if (this.tcpClients.has(server.host)) {
			return
		} // 避免重複初始化

		const client = new net.Socket()
		client.setKeepAlive(true, 30000)
		this.tcpClients.set(server.host, client)
		this.isConnected.set(server.host, false)

		client.on("connect", () => {
			this.isConnected.set(server.host, true)
			console.log(`[amebaRemote] Connected to ${server.name} (${server.host}:${server.port})`)
			this.requestRemotePorts(server.host)
		})

		let buffer = ""
		client.on("data", (data) => {
			buffer += data.toString("utf-8")
			while (buffer.includes("\n")) {
				const [messageStr, remaining] = buffer.split("\n", 2)
				buffer = remaining
				this.handleServerMessage(server, messageStr.trim())
			}
		})

		client.on("close", () => {
			this.isConnected.set(server.host, false)
			console.log(`[amebaRemote] Disconnected from ${server.name}`)
			// 清空該伺服器的端口列表並通知更新
			if (this.remotePorts.get(server.host)?.length) {
				this.remotePorts.set(server.host, [])
				this.onPortsChanged()
			}
		})

		client.on("error", (_err) => {
			// 連線錯誤會觸發 'close' 事件，這裡只記錄日誌即可
		})

		this.connectToServer(server)

		this.startReconnectTimer(server)
	}

	private connectToServer(server: AmebaRemoteServer): void {
		const client = this.tcpClients.get(server.host)
		if (!client || this.isConnected.get(server.host) || client.connecting) {
			return
		}
		client.connect(server.port, server.host)
	}

	private startReconnectTimer(server: AmebaRemoteServer): void {
		const existingTimer = this.reconnectIntervals.get(server.host)
		if (existingTimer) {
			clearInterval(existingTimer)
		}

		const timer = setInterval(() => this.connectToServer(server), 5000)
		this.reconnectIntervals.set(server.host, timer)
	}

	// [修改] 參數從 serverId 改為 host
	private cleanupServerConnection(host: string): void {
		this.tcpClients.get(host)?.destroy()
		const timer = this.reconnectIntervals.get(host)
		if (timer) {
			clearInterval(timer)
		}

		this.tcpClients.delete(host)
		this.isConnected.delete(host)
		this.remotePorts.delete(host)
		this.reconnectIntervals.delete(host)
		console.log(`[amebaRemote] Cleaned up connection for server: ${host}`)
	}

	public dispose(): void {
		for (const host of this.tcpClients.keys()) {
			this.cleanupServerConnection(host)
		}
		console.log("[amebaRemote] All remote connections disposed.")
	}

	public getAllRemotePorts(): RemotePortInfo[] {
		return Array.from(this.remotePorts.values()).flat()
	}

	public requestAllRemotePorts(): void {
		for (const host of this.tcpClients.keys()) {
			if (this.isConnected.get(host)) {
				this.requestRemotePorts(host)
			}
		}
	}

	private handleServerMessage(server: AmebaRemoteServer, messageStr: string): void {
		try {
			const message = JSON.parse(messageStr) as TcpMessage
			if (message.type === "com_ports_update") {
				const newRemotePorts: RemotePortInfo[] = message.ports.map((port) => ({
					path: `R:/${server.host}/${port}`, // [修改] 使用 host 建立路徑
					host: server.host,
					serverName: server.name,
				}))

				const currentPorts = this.remotePorts.get(server.host) || []
				if (JSON.stringify(newRemotePorts) !== JSON.stringify(currentPorts)) {
					this.remotePorts.set(server.host, newRemotePorts)
					this.onPortsChanged()
				}
			}
		} catch (err) {
			console.error(`[amebaRemote] Invalid message from ${server.name}:`, err)
		}
	}

	// [修改] 參數從 serverId 改為 host
	public requestRemotePorts(host: string): void {
		const client = this.tcpClients.get(host)
		if (!client || !this.isConnected.get(host)) {
			return
		}
		client.write(JSON.stringify({ type: "list_com_ports" } as TcpMessage) + "\n", "utf-8")
	}

	public isRemotePort(portPath: string): boolean {
		return portPath.startsWith("R:/")
	}
}
