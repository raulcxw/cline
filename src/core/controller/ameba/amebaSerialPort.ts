import { AmebaRemoteServer } from "@/shared/amebaInfo"
import { AmebaLocalSerialPort, LocalPortInfo } from "./amebaLocalSerialPort"
import { AmebaRemoteSerialPort, RemotePortInfo } from "./amebaRemoteSerialPort"

// [修改] PortInfo 的組成類型已更新
export type PortInfo = (LocalPortInfo | RemotePortInfo) & {
	isRemote: boolean
	serverName: string
	host: string
}

export type PortChangeCallback = (ports: PortInfo[], isFirst: boolean) => void

export class AmebaSerialPort {
	private localManager: AmebaLocalSerialPort
	private remoteManager: AmebaRemoteSerialPort
	private onPortsChanged: PortChangeCallback
	private isFirstCheck: boolean = true

	// [修改] 簡化構造函數
	constructor(onPortsChanged: PortChangeCallback, interval: number = 2000) {
		this.onPortsChanged = onPortsChanged

		this.localManager = new AmebaLocalSerialPort(() => {
			this.mergeAndNotifyPorts()
		}, interval)

		this.remoteManager = new AmebaRemoteSerialPort(() => {
			this.mergeAndNotifyPorts()
		})
	}

	public dispose(): void {
		this.localManager.dispose()
		this.remoteManager.dispose()
	}

	// [修改] 更新方法簽名以接收新的 AmebaRemoteServer 類型
	public updateServerList(servers: AmebaRemoteServer[]): void {
		this.remoteManager.updateServerList(servers)
	}

	public async forceCheckForPortChanges(): Promise<void> {
		await this.localManager.forceCheckForPortChanges()
		this.remoteManager.requestAllRemotePorts()
	}

	private mergeAndNotifyPorts(): void {
		const localPorts: PortInfo[] = this.localManager.getCurrentPorts().map((port) => ({
			...port,
			isRemote: false,
			serverName: "Local",
			host: "local", // 為本地端口添加 host 屬性
		}))

		const remotePorts: PortInfo[] = this.remoteManager.getAllRemotePorts().map((port) => ({
			...port,
			isRemote: true,
		}))

		const allPortsMap = new Map<string, PortInfo>()
		;[...localPorts, ...remotePorts].forEach((port) => {
			allPortsMap.set(port.path, port)
		})

		const allPorts = Array.from(allPortsMap.values())
		this.onPortsChanged(allPorts, this.isFirstCheck)
		if (this.isFirstCheck) {
			this.isFirstCheck = false
		}
	}

	// [移除] 不再需要 isRemotePort 和其他伺服器管理代理方法
}
