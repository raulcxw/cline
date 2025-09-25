import { promises as fs } from "fs"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from "../index"

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.stat(filePath)
		return true
	} catch (error) {
		return false
	}
}

export async function amebaTerminalCheck(projectPath: string): Promise<boolean> {
	const configTmpPath = path.join(projectPath, "menuconfig", "config_tmp")
	console.log(`[Ameba Check] Checking for lingering session file: ${configTmpPath}`)

	if (await fileExists(configTmpPath)) {
		HostProvider.window.showMessage({
			type: ShowMessageType.WARNING,
			message: "Last Menuconfig not closed. Please Save & Exit in terminal, and then try again.",
		})

		console.warn(`[Ameba Terminal Check] Lingering session detected at ${configTmpPath}. Aborting.`)
		return false // 檢查失敗
	}

	return true // 檢查成功
}
