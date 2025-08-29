// src/core/controller/ameba/amebaSerialPortManager.ts

import { type DeviceInfo, SerialPortLite } from "serialport-lite"

// 使用 type alias 讓程式碼意圖更清晰，PortInfo 就是我們從庫中獲取到的串口資訊
export type PortInfo = DeviceInfo

export class SerialPortManager {
	private currentPorts: PortInfo[] = []
	private checkInterval: NodeJS.Timeout
	private onPortsChanged: (ports: PortInfo[], isFirst: boolean) => void
	private isFirstCheck: boolean = true

	constructor(onPortsChanged: (ports: PortInfo[], isFirst: boolean) => void, interval: number = 2000) {
		this.onPortsChanged = onPortsChanged
		this.forceCheckForPortChanges() // 立即執行一次
		this.checkInterval = setInterval(() => this.checkForPortChanges(), interval)
	}

	public dispose(): void {
		clearInterval(this.checkInterval)
	}

	public async forceCheckForPortChanges(): Promise<void> {
		await this.checkForPortChanges()
	}

	private async checkForPortChanges() {
		try {
			// 直接使用 `serialport-lite` 的靜態方法
			const newPorts: PortInfo[] = await SerialPortLite.list()

			// 比較字串化結果是個簡單有效的深比較方式
			if (JSON.stringify(newPorts) !== JSON.stringify(this.currentPorts)) {
				console.log("Serial port change detected. New ports:", newPorts)
				this.currentPorts = newPorts
				this.onPortsChanged(this.currentPorts, this.isFirstCheck)
			} else if (this.isFirstCheck) {
				// 即使埠號沒變，第一次也需要通知 Controller
				this.onPortsChanged(this.currentPorts, this.isFirstCheck)
			}

			this.isFirstCheck = false
		} catch (error) {
			console.error("Failed to list serial ports:", error)
			// 如果出錯，且之前有埠號列表，則清空
			if (this.currentPorts.length > 0 || this.isFirstCheck) {
				this.currentPorts = []
				this.onPortsChanged([], this.isFirstCheck)
			}
			this.isFirstCheck = false
		}
	}
}
