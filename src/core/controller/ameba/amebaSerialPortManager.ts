// amebaSerialPortManager.ts (精簡優化版)

import os from "node:os"
import { execa } from "execa"

/**
 * 精簡後的 PortInfo 型別，只包含必要的路徑資訊。
 */
export type PortInfo = {
	path: string
}

/**
 * 一個透過定期輪詢 (Polling) 機制來監控序列埠變更的管理類。
 * 它會定期執行系統指令來獲取當前的序列埠列表，並在列表發生變化時觸發回呼。
 */
export class SerialPortManager {
	private currentPorts: PortInfo[] = []
	private checkInterval: NodeJS.Timeout
	private onPortsChanged: (ports: PortInfo[], isFirst: boolean) => void
	private isFirstCheck: boolean = true
	private isChecking: boolean = false // 防止因非同步操作耗時過長而導致的重複執行

	constructor(onPortsChanged: (ports: PortInfo[], isFirst: boolean) => void, interval: number = 2000) {
		this.onPortsChanged = onPortsChanged
		this.forceCheckForPortChanges() // 建立實例時立即執行一次，確保初始狀態
		this.checkInterval = setInterval(() => this.checkForPortChanges(), interval)
	}

	/**
	 * 釋放資源，停止定時器。
	 */
	public dispose(): void {
		clearInterval(this.checkInterval)
	}

	/**
	 * 提供一個公開方法來強制觸發一次埠掃描。
	 */
	public async forceCheckForPortChanges(): Promise<void> {
		await this.checkForPortChanges()
	}

	/**
	 * 執行平台特定的指令來列出所有序列埠的路徑。
	 * 此函數已被大幅簡化，所有平台都只返回一個純粹的路徑字串列表。
	 */
	private async listPorts(): Promise<PortInfo[]> {
		const platform = os.platform()
		let command: string
		let args: string[]

		switch (platform) {
			case "win32":
				// 極簡化指令：只獲取 FriendlyName 中的 COM Port 部分 (例如 "COM13")。
				// 不再需要 ConvertTo-Json，直接輸出純字串，效能更好。
				command = "powershell.exe"
				args = [
					"-NoProfile",
					"-Command",
					"Get-PnpDevice -Class 'Ports' | Where-Object { $_.Present -eq $true } | ForEach-Object { ($_.Name -split '[()]')[1] }",
				]
				break

			case "darwin": // macOS
				command = "ls"
				args = ["/dev/cu.*"]
				break

			default: // linux and other
				command = "sh"
				args = ["-c", "ls /dev/ttyUSB* /dev/ttyACM* 2>/dev/null || true"]
				break
		}

		try {
			// reject: false 讓指令即使找不到任何裝置 (stderr) 也不會拋出例外
			const { stdout } = await execa(command, args, { reject: false })
			if (!stdout) {
				return [] // 沒有輸出，代表沒有找到任何埠
			}
			// 所有平台的輸出現在都是以換行符分隔的路徑列表，可共用此解析邏輯
			return stdout
				.split("\n")
				.map((path) => path.trim())
				.filter(Boolean) // 過濾掉空行
				.map((path) => ({ path })) // 轉換為 PortInfo 物件
		} catch (error) {
			console.error(`[amebaSerialPortManager] Failed to list serial ports on ${platform}:`, error)
			return []
		}
	}

	/**
	 * 檢查埠列表是否發生變化，如果變化則觸發回呼函數。
	 */
	private async checkForPortChanges() {
		if (this.isChecking) {
			return // 如果上一次檢查尚未完成，則跳過本次，防止重複執行
		}
		this.isChecking = true

		try {
			const newPorts = await this.listPorts()

			// 優化比較邏輯：將路徑陣列排序後轉為字串進行比較，簡單高效。
			const newPortPaths = newPorts.map((p) => p.path).sort()
			const currentPortPaths = this.currentPorts.map((p) => p.path).sort()

			if (JSON.stringify(newPortPaths) !== JSON.stringify(currentPortPaths)) {
				console.log("[ameba] Serial port change detected. New ports:", newPorts.map((p) => p.path).join(", ") || "None")
				this.currentPorts = newPorts
				this.onPortsChanged(this.currentPorts, this.isFirstCheck)
			} else if (this.isFirstCheck) {
				// 即使埠列表相同，第一次檢查也需要觸發回呼，以傳遞初始狀態。
				this.onPortsChanged(this.currentPorts, this.isFirstCheck)
			}
		} catch (error) {
			console.error("[ameba] Failed to check for serial port changes:", error)
			// 如果檢查過程中發生錯誤，視為埠列表為空
			if (this.currentPorts.length > 0 || this.isFirstCheck) {
				this.currentPorts = []
				this.onPortsChanged([], this.isFirstCheck)
			}
		} finally {
			this.isFirstCheck = false
			this.isChecking = false
		}
	}
}
