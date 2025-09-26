import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from "../index"
import { amebaTerminalCheck } from "./amebaTerminalCheck"

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
				message: "Serial Port not selected.",
			})
			return Empty.create({})
		}

		// 3. Construct the build directory path dynamically based on the IC selection.
		// Example: if icSelection is "amebalite", this becomes "amebalite_gcc_project"
		const monitorProjectDirName = `${icSelection}_gcc_project`
		const monitorDir = path.join(sdkRoot, monitorProjectDirName)

		const isSafeToProceed = await amebaTerminalCheck(monitorDir)
		if (!isSafeToProceed) {
			return Empty.create({})
		}

		// 4. Define the build command.
		const effectivePort = serialPort.isRemote ? path.basename(serialPort.path) : serialPort.path

		let baudrate: string
		if (icSelection == "amebad") {
			baudrate = "-b 115200"
		} else {
			baudrate = "-b 1500000"
		}

		const commandParts: string[] = ["python", "monitor.py", "-b 1500000", "--port", effectivePort, "-reset"]

		if (serialPort.isRemote) {
			const remoteHost = serialPort.host
			commandParts.push("--remote-server", remoteHost)
			if (serialPort.pw) {
				commandParts.push("--remote-password", serialPort.pw)
			}
		}

		const monitorCommand = commandParts.join(" ")

		// 5. Get a dedicated terminal for Ameba tasks.
		const terminalManager = controller.amebaTerminalManager
		const terminalInfo = await terminalManager.getOrCreateAmebaTerminal(sdkRoot)
		if (!terminalInfo) {
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Failed to create Ameba terminal." })
			return Empty.create({})
		}

		// 6. Show the terminal and execute the commands.
		terminalInfo.terminal.show()
		terminalInfo.terminal.sendText(`cd "${monitorDir}"`, true)
		console.log(`amebaMonitor to terminal: cd "${monitorDir}"`)
		terminalInfo.terminal.sendText(monitorCommand, true)
		console.log(`amebaMonitor to terminal: ${monitorCommand}`)

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
