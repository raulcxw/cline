import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from "../index"

export async function amebaMonitor(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		// 1. Get the SDK root and selected IC and serial port dynamically from the controller.
		const sdkRoot = await controller.getAmebaSdkRoot()
		const icSelection = await controller.getAmebaIcSelection()
		const serialPort = await controller.getSelectedAmebaSerialPort()

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

		// 2.3 Check if Serial Port is selected
		if (!serialPort) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Serial Port not selected. Please select serial port",
			})
			return Empty.create({})
		}

		// 3. Construct the build directory path dynamically based on the IC selection.
		// Example: if icSelection is "amebalite", this becomes "amebalite_gcc_project"
		const monitorProjectDirName = `${icSelection}_gcc_project`
		const monitorDir = path.join(sdkRoot, monitorProjectDirName)

		// 4. Define the build command.
		const monitorScript = `python monitor.py -p ${serialPort.path} -b 1500000 -reset`

		// 5. Get a dedicated terminal for Ameba tasks.
		// The terminal's initial CWD is set to the SDK root for consistency.
		const terminalManager = controller.amebaTerminalManager
		const terminalInfo = await terminalManager.getOrCreateAmebaTerminal(sdkRoot)

		if (!terminalInfo) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to create or find the Ameba terminal.",
			})
			console.error("amebaMonitor: terminalInfo is undefined. Aborting build.")
			return Empty.create({})
		}

		// 6. Show the terminal and execute the commands.
		terminalInfo.terminal.show()

		// Command 1: Change directory to the specific project folder.
		// Quoting "${buildDir}" handles potential spaces in the file path.
		terminalInfo.terminal.sendText(`cd "${monitorDir}"`, true)
		console.log(`amebaMonitor to terminal: cd "${monitorDir}"`)

		// Command 2: Execute the build script in that directory.
		terminalInfo.terminal.sendText(monitorScript, true)
		console.log(`amebaMonitor to terminal: ${monitorScript}`)

		return Empty.create({})
	} catch (error) {
		console.error("Failed to execute amebaMonitor command:", error)
		const errorMessage = error instanceof Error ? error.message : String(error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `An error occurred during the monitor process: ${errorMessage}`,
		})
		return Empty.create({})
	}
}
