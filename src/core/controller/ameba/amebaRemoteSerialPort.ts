import * as net from "node:net"
import * as os from "node:os"
import { ShowMessageType } from "@shared/proto/host/window"
import { HostProvider } from "@/hosts/host-provider"
import { AmebaRemoteServer, RemotePortInfo } from "@/shared/amebaInfo"

export type ServerConfigs = AmebaRemoteServer[]

export type TcpMessage =
	| { type: "com_ports_update"; ports: string[] }
	| { type: "list_com_ports" }
	| { type: "validate"; password: string }
	| { type: "command_response"; success: boolean; message?: string }

function getLocalIpAddresses(): Set<string> {
	const networkInterfaces = os.networkInterfaces()
	const allAddresses = Object.values(networkInterfaces).flat()

	const ipv4Addresses = allAddresses
		.filter((details) => details && details.family === "IPv4" && !details.internal)
		.map((details) => details!.address)

	// 也包含本地回環地址，以防萬一
	ipv4Addresses.push("127.0.0.1")
	return new Set(ipv4Addresses)
}

export class AmebaRemoteSerialPort {
	private servers: ServerConfigs = []
	// [修改] 所有 Map 的鍵都改為 string (host)
	private tcpClients: Map<string, net.Socket> = new Map()
	private isConnected: Map<string, boolean> = new Map()
	private isAuthenticated: Map<string, boolean> = new Map()
	private remotePorts: Map<string, RemotePortInfo[]> = new Map()
	private reconnectIntervals: Map<string, NodeJS.Timeout> = new Map()
	private passwordErrorNotified: Map<string, boolean> = new Map()
	private onPortsChanged: () => void

	// [修改] 簡化構造函數
	constructor(onPortsChanged: () => void) {
		this.onPortsChanged = onPortsChanged
	}

	// [新增] 這是現在與外部溝通的主要方式
	public updateServerList(newServers: ServerConfigs): void {
		const localIps = getLocalIpAddresses()
		const newValidServers = newServers.filter((server) => {
			const isLocal = localIps.has(server.host)
			console.log(`[amebaRemote-DEBUG] -> Checking server "${server.name}" (${server.host}). Is local? ${isLocal}`)
			if (isLocal) {
				console.log(`[amebaRemote] Ignoring server "${server.name}" (${server.host}) because it is a local IP.`)
			}
			return !isLocal
		})

		const newServerHosts = new Set(newValidServers.map((s) => s.host))
		const oldServerHosts = new Set(this.servers.map((s) => s.host))

		// 找出被刪除的伺服器並清理資源
		for (const host of oldServerHosts) {
			if (!newServerHosts.has(host)) {
				this.cleanupServerConnection(host)
			}
		}

		// 更新內部伺服器列表
		this.servers = newValidServers

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
		this.passwordErrorNotified.set(server.host, false)

		client.on("connect", () => {
			this.isConnected.set(server.host, true)
			console.log(`[amebaRemote] Connected to ${server.name} (${server.host}:${server.port})`)

			const existingTimer = this.reconnectIntervals.get(server.host)
			if (existingTimer) {
				clearInterval(existingTimer)
				this.reconnectIntervals.delete(server.host)
			}

			//this.passwordErrorNotified.set(server.host, false)

			if (server.pw) {
				console.log(`[amebaRemote] Server "${server.name}" requires authentication. Sending password...`)
				const authMessage: TcpMessage = { type: "validate", password: server.pw }
				client.write(JSON.stringify(authMessage) + "\n", "utf-8")
			} else {
				console.log(`[amebaRemote] Server "${server.name}" does not require authentication.`)
				this.isAuthenticated.set(server.host, true)
				this.requestRemotePorts(server.host)
			}
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
			this.isAuthenticated.set(server.host, false)
			console.log(`[amebaRemote] Disconnected from ${server.name}`)
			// 清空該伺服器的端口列表並通知更新
			if (this.remotePorts.get(server.host)?.length) {
				this.remotePorts.set(server.host, [])
				this.onPortsChanged()
			}
			this.startReconnectTimer(server)
		})

		client.on("error", (_err) => {
			// 連線錯誤會觸發 'close' 事件，這裡只記錄日誌即可
			console.log(`[amebaRemote] error from ${server.name}`)
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
		if (this.reconnectIntervals.has(server.host)) {
			return
		}

		const timer = setInterval(() => this.connectToServer(server), 5000)
		this.reconnectIntervals.set(server.host, timer)
	}

	// [修改] 參數從 serverId 改為 host
	private cleanupServerConnection(host: string): void {
		const timer = this.reconnectIntervals.get(host)
		if (timer) {
			clearInterval(timer)
			this.reconnectIntervals.delete(host)
		}
		this.tcpClients.get(host)?.destroy()
		this.tcpClients.delete(host)
		this.isConnected.delete(host)
		this.isAuthenticated.delete(host)
		this.remotePorts.delete(host)
		this.passwordErrorNotified.delete(host)
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
		if (!messageStr) return
		try {
			const message = JSON.parse(messageStr) as TcpMessage

			switch (message.type) {
				case "command_response":
					if (message.success) {
						console.log(`[amebaRemote] Authentication successful for ${server.name}.`)
						this.isAuthenticated.set(server.host, true)
						this.passwordErrorNotified.set(server.host, false)
						this.requestRemotePorts(server.host)
					} else {
						console.error(
							`[amebaRemote] Authentication failed for ${server.name}. Reason: ${message.message || "Unknown"}`,
						)

						// 檢查是否為密碼不匹配，且尚未提示過使用者
						if (message.message === "Password is mis-matched" && !this.passwordErrorNotified.get(server.host)) {
							// 設定旗標，防止重複提示
							this.passwordErrorNotified.set(server.host, true)

							// 透過 HostProvider 顯示一個非強制性的錯誤訊息
							HostProvider.window.showMessage({
								type: ShowMessageType.WARNING,
								message: `Incorrect Password for remote server "${server.name}" (${server.host}) . Please check your settings.`,
							})
						} else if (
							message.message === "Password should be validated first" &&
							!this.passwordErrorNotified.get(server.host)
						) {
							// 設定旗標，防止重複提示
							this.passwordErrorNotified.set(server.host, true)

							// 透過 HostProvider 顯示一個非強制性的錯誤訊息
							HostProvider.window.showMessage({
								type: ShowMessageType.WARNING,
								message: `Need Password for remote server "${server.name}" (${server.host}). Please check your settings.`,
							})
						}
						this.tcpClients.get(server.host)?.destroy()
					}
					break

				case "com_ports_update":
					// 只有在已認證的情況下才處理端口更新
					if (this.isAuthenticated.get(server.host)) {
						const newRemotePorts: RemotePortInfo[] = message.ports.map((port) => ({
							path: `R:/${server.host}/${port}`,
							host: server.host,
							serverName: server.name,
							pw: server.pw,
						}))

						const currentPorts = this.remotePorts.get(server.host) || []
						if (JSON.stringify(newRemotePorts) !== JSON.stringify(currentPorts)) {
							this.remotePorts.set(server.host, newRemotePorts)
							this.onPortsChanged()
						}
					}
					break
			}
		} catch (err) {
			console.error(`[amebaRemote] Invalid message from ${server.name}:`, messageStr, err)
		}
	}

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
