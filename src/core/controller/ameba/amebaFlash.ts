import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import * as fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from "../index"

/**
 * Defines the structure for a parsed flash memory region.
 */
interface FlashRegionInfo {
	type: string
	startAddr: string
	endAddr: string
}

/**
 * Parses the content of ameba_flashcfg.c to extract the Flash_Layout array.
 * @param fileContent The string content of the C file.
 * @returns An array of FlashRegionInfo objects.
 */
function parseFlashLayout(fileContent: string): FlashRegionInfo[] {
	const layout: FlashRegionInfo[] = []
	// Regex to match lines like: {IMG_BOOT, 0x08000000, 0x08013FFF}
	const regex = /\{\s*(\w+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\}/g

	let match: RegExpExecArray | null
	while ((match = regex.exec(fileContent)) !== null) {
		// Ignore the final entry {0xFF, 0xFFFFFFFF, 0xFFFFFFFF}
		if (match[1] === "0xFF") {
			continue
		}
		layout.push({
			type: match[1],
			startAddr: match[2],
			endAddr: match[3],
		})
	}
	return layout
}

/**
 * Validates the parsed flash layout against a set of rules.
 * @param layout The array of FlashRegionInfo objects.
 * @returns An object with validation status and an error message if invalid.
 */
function validateFlashLayout(layout: FlashRegionInfo[]): { isValid: boolean; error?: string } {
	// Rule 3.1: Filter out placeholder entries before validation.
	const validRegions = layout.filter((region) => !(region.startAddr === "0xFFFFFFFF" && region.endAddr === "0xFFFFFFFF"))

	// Sort by start address to make overlap checks easier.
	try {
		validRegions.sort((a, b) => parseInt(a.startAddr, 16) - parseInt(b.startAddr, 16))
	} catch (e) {
		return { isValid: false, error: "Failed to sort regions due to invalid hex address format." }
	}

	for (let i = 0; i < validRegions.length; i++) {
		const region = validRegions[i]
		const startNum = parseInt(region.startAddr, 16)
		const endNum = parseInt(region.endAddr, 16)

		if (isNaN(startNum) || isNaN(endNum)) {
			return { isValid: false, error: `Region ${region.type} has a non-hexadecimal address.` }
		}

		// Rule 3.2: Start address must be less than end address.
		if (startNum >= endNum) {
			return {
				isValid: false,
				error: `Validation failed for region ${region.type}: Start address (${region.startAddr}) must be less than end address (${region.endAddr}).`,
			}
		}

		// Rule 3.3 & 3.4: Check for 4K alignment and "0x" prefix.
		if (!/^0x[0-9a-fA-F]+000$/.test(region.startAddr)) {
			return {
				isValid: false,
				error: `Validation failed for region ${region.type}: Start address (${region.startAddr}) is not 4K-aligned (must end in '000').`,
			}
		}
		if (!/^0x[0-9a-fA-F]+FFF$/.test(region.endAddr)) {
			return {
				isValid: false,
				error: `Validation failed for region ${region.type}: End address (${region.endAddr}) is not 4K-aligned (must end in 'FFF').`,
			}
		}

		// Rule 3.5: Check for address range overlap with the next region.
		if (i + 1 < validRegions.length) {
			const nextRegion = validRegions[i + 1]
			const nextStartNum = parseInt(nextRegion.startAddr, 16)
			// If the current region's end address is greater than or equal to the next region's start, they overlap.
			if (endNum >= nextStartNum) {
				return {
					isValid: false,
					error: `Validation failed: Address range of region ${region.type} (${region.startAddr} - ${region.endAddr}) overlaps with region ${nextRegion.type} (${nextRegion.startAddr}).`,
				}
			}
		}
	}

	return { isValid: true }
}

export async function amebaFlash(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		// 1. & 2. Get and check settings (now with English messages)
		const sdkRoot = await controller.getAmebaSdkRoot()
		const icSelection = await controller.getAmebaIcSelection()
		const serialPort = await controller.getSelectedAmebaSerialPort()

		if (!sdkRoot) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Ameba SDK root directory not configured. Please open an Ameba SDK project.",
			})
			return Empty.create({})
		}
		if (!icSelection) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Ameba IC not selected. Please select Ameba IC.",
			})
			return Empty.create({})
		}
		if (!serialPort) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Serial Port not selected. Please select serial port.",
			})
			return Empty.create({})
		}

		// 3. Read and parse ameba_flashcfg.c
		const flashCfgPath = path.join(sdkRoot, "component", "soc", "usrcfg", icSelection, "ameba_flashcfg.c")
		let flashLayout: FlashRegionInfo[] = []

		try {
			const fileContent = await fs.readFile(flashCfgPath, "utf-8")
			flashLayout = parseFlashLayout(fileContent)
			if (flashLayout.length === 0) {
				throw new Error(`Could not parse any flash layout information from ${flashCfgPath}.`)
			}
		} catch (parseError) {
			const userMessage = parseError instanceof Error ? parseError.message : String(parseError)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to process config file: ${userMessage}`,
			})
			return Empty.create({})
		}

		// *** NEW: Validate the parsed layout ***
		const validationResult = validateFlashLayout(flashLayout)
		if (!validationResult.isValid) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Invalid flash layout in ${flashCfgPath}: ${validationResult.error}`,
			})
			return Empty.create({})
		}

		// 4. Define the mapping from image type to actual firmware file name.
		const imageTypeToFileName = new Map<string, string>([
			["IMG_BOOT", "km4_boot_all.bin"],
			["IMG_APP_OTA1", "km0_km4_app.bin"],
		])

		// 5. Build the flash command based on the parsed layout.
		const commandParts: string[] = ["python", "flash.py", "--port", serialPort]

		for (const currentRegion of flashLayout) {
			const imageFileName = imageTypeToFileName.get(currentRegion.type)

			if (imageFileName) {
				// Requirement 2: Always use endAddr + 1 for the command's end address.
				try {
					const endAddrNum = parseInt(currentRegion.endAddr, 16)
					const commandEndAddr = `0x${(endAddrNum + 1).toString(16).toUpperCase()}`
					commandParts.push("--image", imageFileName, currentRegion.startAddr, commandEndAddr)
				} catch (e) {
					// This should not happen due to prior validation, but it's good practice.
					console.error(`Could not calculate end address for ${currentRegion.type}:`, e)
				}
			}
		}

		if (commandParts.length <= 4) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message:
					"No burnable image types (like IMG_BOOT, IMG_APP_OTA1) defined in the mapping were found in the config file.",
			})
			return Empty.create({})
		}

		const flashCommand = commandParts.join(" ")

		// 6. Get the terminal and execute the command.
		const flashProjectDirName = `${icSelection}_gcc_project`
		const flashDir = path.join(sdkRoot, flashProjectDirName)

		const terminalManager = controller.amebaTerminalManager
		const terminalInfo = await terminalManager.getOrCreateAmebaTerminal(sdkRoot)
		if (!terminalInfo) {
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Failed to create Ameba terminal." })
			return Empty.create({})
		}

		terminalInfo.terminal.show()
		terminalInfo.terminal.sendText(`cd "${flashDir}"`, true)
		console.log(`amebaflash to terminal path: ${flashDir}`)
		terminalInfo.terminal.sendText(flashCommand, true)
		console.log(`amebaflash to terminal cmd: ${flashCommand}`)

		return Empty.create({})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `An error occurred during the flashing process: ${errorMessage}`,
		})
		return Empty.create({})
	}
}
