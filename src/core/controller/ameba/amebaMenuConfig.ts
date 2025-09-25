import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from "../index"
import { amebaTerminalCheck } from "./amebaTerminalCheck" // <-- 請根據您的檔案結構調整此路徑

export async function amebaMenuConfig(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		// 1. Get the SDK root and selected IC and serial port dynamically from the controller.
		const sdkRoot = await controller.getAmebaSdkRoot()
		const icSelection = await controller.getAmebaIcSelection()

		// 2.1 Check if the SDK path is available.
		if (!sdkRoot) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Ameba SDK root directory not configured. Please open an Ameba SDK project",
			})
			return Empty.create({})
		}

		// 2.2 Check if ameba IC is selected.
		if (!icSelection) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Ameba IC not selected. Please select Ameba IC",
			})
			return Empty.create({})
		}

		// 3. Construct the Menuconfig directory path dynamically based on the IC selection.
		// Example: if icSelection is "amebalite", this becomes "amebalite_gcc_project"
		const MenuconfigProjectDirName = `${icSelection}_gcc_project`
		const MenuconfigDir = path.join(sdkRoot, MenuconfigProjectDirName)

		const isSafeToProceed = await amebaTerminalCheck(MenuconfigDir)
		if (!isSafeToProceed) {
			return Empty.create({})
		}

		// 4. Define the build command.
		const MenuconfigScriptName = "python menuconfig.py"

		// 5. Get a dedicated terminal for Ameba tasks.
		// The terminal's initial CWD is set to the SDK root for consistency.
		const terminalManager = controller.amebaTerminalManager
		const terminalInfo = await terminalManager.getOrCreateAmebaTerminal(sdkRoot)

		if (!terminalInfo) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to create or find the Ameba terminal.",
			})
			console.error("amebaMenuConfig: terminalInfo is undefined. Aborting Menuconfig.")
			return Empty.create({})
		}

		// 6. Show the terminal and execute the commands.
		terminalInfo.terminal.show()

		// Command 1: Change directory to the specific project folder.
		// Quoting "${MenuconfigDir}" handles potential spaces in the file path.
		terminalInfo.terminal.sendText(`cd "${MenuconfigDir}"`, true)
		console.log(`amebaMenuconfig to terminal: cd "${MenuconfigDir}"`)

		// Command 2: Execute the Menuconfig script in that directory.
		terminalInfo.terminal.sendText(MenuconfigScriptName, true)
		console.log(`amebaMenuconfig to terminal: ${MenuconfigScriptName}`)

		return Empty.create({})
	} catch (error) {
		console.error("Failed to execute amebaMenuconfig command:", error)
		const errorMessage = error instanceof Error ? error.message : String(error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `An error occurred during the Menuconfig process: ${errorMessage}`,
		})
		return Empty.create({})
	}
}
