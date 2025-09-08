import os from "node:os"
import { execa } from "execa"

export type LocalPortInfo = {
	path: string
}

export type PortChangeCallback = (ports: LocalPortInfo[], isFirst: boolean) => void

export class AmebaLocalSerialPort {
	private currentPorts: LocalPortInfo[] = []
	private checkInterval: NodeJS.Timeout
	private onPortsChanged: PortChangeCallback
	private isFirstCheck: boolean = true
	private isChecking: boolean = false

	constructor(onPortsChanged: PortChangeCallback, interval: number = 2000) {
		this.onPortsChanged = onPortsChanged

		// 初始化本地串口扫描
		this.forceCheckForPortChanges()
		this.checkInterval = setInterval(() => this.checkForPortChanges(), interval)
	}

	/**
	 * 释放资源
	 */
	public dispose(): void {
		clearInterval(this.checkInterval)
	}

	/**
	 * 强制刷新本地串口列表
	 */
	public async forceCheckForPortChanges(): Promise<void> {
		await this.checkForPortChanges()
	}

	/**
	 * 获取当前本地串口列表
	 */
	public getCurrentPorts(): LocalPortInfo[] {
		return [...this.currentPorts]
	}

	/**
	 * 扫描本地串口
	 */
	private async listPorts(): Promise<LocalPortInfo[]> {
		const platform = os.platform()
		let command: string
		let args: string[]

		switch (platform) {
			case "win32":
				command = "powershell.exe"
				args = [
					"-NoProfile",
					"-Command",
					"Get-PnpDevice -Class 'Ports' | Where-Object { $_.Present -eq $true } | ForEach-Object { ($_.Name -split '[()]')[1] }",
				]
				break
			case "darwin":
				command = "ls"
				args = ["/dev/cu.*"]
				break
			default: // linux
				command = "sh"
				args = ["-c", "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true"]
				break
		}

		try {
			const { stdout } = await execa(command, args, { reject: false })
			if (!stdout) {
				return []
			}
			return stdout
				.split("\n")
				.map((path) => path.trim())
				.filter(Boolean)
				.map((path) => ({ path }))
		} catch (error) {
			console.error(`[amebaLocalSerialPort] Failed to list local ports:`, error)
			return []
		}
	}

	/**
	 * 检查本地串口变化
	 */
	private async checkForPortChanges() {
		if (this.isChecking) {
			return
		}
		this.isChecking = true

		try {
			const newLocalPorts = await this.listPorts()
			const newLocalPortPaths = newLocalPorts.map((p) => p.path).sort()
			const currentLocalPortPaths = this.currentPorts.map((p) => p.path).sort()

			if (JSON.stringify(newLocalPortPaths) !== JSON.stringify(currentLocalPortPaths)) {
				console.log("[amebaLocal] Local port change detected:", newLocalPorts.map((p) => p.path).join(", "))
				this.currentPorts = newLocalPorts
				this.onPortsChanged(this.currentPorts, this.isFirstCheck)
			} else if (this.isFirstCheck) {
				this.onPortsChanged(this.currentPorts, this.isFirstCheck)
			}
		} catch (error) {
			console.error("[amebaLocal] Failed to check local port changes:", error)
			this.currentPorts = []
			this.onPortsChanged(this.currentPorts, this.isFirstCheck)
		} finally {
			this.isFirstCheck = false
			this.isChecking = false
		}
	}

	public getPorts(): LocalPortInfo[] {
		// 返回当前缓存的本地端口
		return [...this.currentPorts] // 返回副本避免外部直接修改
	}
}
