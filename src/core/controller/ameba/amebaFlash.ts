import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import * as fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import type { Controller } from "../index"

interface FlashRegionInfo {
	type: string
	startAddr: string
	endAddr: string
	lineNumber: number
}

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath)
		return true
	} catch {
		return false
	}
}

interface FlashLayoutParseResult {
	layout: FlashRegionInfo[]
	definitionLine: number
}

function parseFlashLayout(fileContent: string, filePath: string): FlashLayoutParseResult {
	const result: FlashLayoutParseResult = {
		layout: [],
		definitionLine: -1,
	}
	const lines = fileContent.split(/\r?\n/)
	const targetDefinitionRegex = /^\s*(const\s+)?FlashLayoutInfo_TypeDef\s+Flash_Layout\s*\[\s*\]/
	const layoutDefinitions: { lineNumber: number; lineIndex: number }[] = []
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (targetDefinitionRegex.test(line)) {
			layoutDefinitions.push({
				lineNumber: i + 1,
				lineIndex: i,
			})
		}
	}
	if (layoutDefinitions.length === 0) {
		throw new Error(`Could not find 'FlashLayoutInfo_TypeDef Flash_Layout' definition in ${filePath}`)
	}
	const targetDef = layoutDefinitions.length >= 2 ? layoutDefinitions[layoutDefinitions.length - 1] : layoutDefinitions[0]
	result.definitionLine = targetDef.lineNumber
	let inTargetLayout = false
	let braceCount = 0
	for (let i = targetDef.lineIndex; i < lines.length; i++) {
		const lineNumber = i + 1
		const line = lines[i]
		if (!inTargetLayout && targetDefinitionRegex.test(line)) {
			inTargetLayout = true
			if (line.includes("{")) {
				braceCount += (line.match(/{/g) || []).length
			}
			if (line.includes("}")) {
				braceCount -= (line.match(/}/g) || []).length
			}
			if (braceCount > 0) {
				continue
			}
		}
		if (inTargetLayout) {
			braceCount += (line.match(/{/g) || []).length
			braceCount -= (line.match(/}/g) || []).length
			const entryRegex = /\{\s*(\w+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\}/g
			let match: RegExpExecArray | null
			while ((match = entryRegex.exec(line)) !== null) {
				if (match[1] === "0xFF") {
					continue
				}
				result.layout.push({
					type: match[1],
					startAddr: match[2],
					endAddr: match[3],
					lineNumber: lineNumber,
				})
			}
			if (braceCount <= 0) {
				inTargetLayout = false
				break
			}
		}
	}
	if (result.layout.length === 0) {
		throw new Error(`No valid entries found in 'Flash_Layout' table (line ${result.definitionLine}) in ${filePath}`)
	}
	return result
}

function validateFlashLayout(layout: FlashRegionInfo[]): { isValid: boolean; error?: string } {
	const validRegions = layout.filter((region) => !(region.startAddr === "0xFFFFFFFF" && region.endAddr === "0xFFFFFFFF"))
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
			return { isValid: false, error: `Region ${region.type} (line ${region.lineNumber}) has a non-hexadecimal address.` }
		}
		if (startNum >= endNum) {
			return {
				isValid: false,
				error: `Validation failed for region ${region.type} (line ${region.lineNumber}): Start address (${region.startAddr}) must be less than end address (${region.endAddr}).`,
			}
		}
		if (!/^0x[0-9a-fA-F]+000$/.test(region.startAddr)) {
			return {
				isValid: false,
				error: `Validation failed for region ${region.type} (line ${region.lineNumber}): Start address (${region.startAddr}) is not 4K-aligned (must end in '000').`,
			}
		}
		if (!/^0x[0-9a-fA-F]+FFF$/.test(region.endAddr)) {
			return {
				isValid: false,
				error: `Validation failed for region ${region.type} (line ${region.lineNumber}): End address (${region.endAddr}) is not 4K-aligned (must end in 'FFF').`,
			}
		}
		if (i + 1 < validRegions.length) {
			const nextRegion = validRegions[i + 1]
			const nextStartNum = parseInt(nextRegion.startAddr, 16)
			if (endNum >= nextStartNum) {
				return {
					isValid: false,
					error: `Validation failed: Region ${region.type} (line ${region.lineNumber}) (${region.startAddr} - ${region.endAddr}) overlaps with region ${nextRegion.type} (line ${nextRegion.lineNumber}) (${nextRegion.startAddr}).`,
				}
			}
		}
	}
	return { isValid: true }
}

async function openFlashCfgFileAtLayoutDefinition(filePath: string, definitionLine: number) {
	try {
		await HostProvider.window.showTextDocument({
			path: filePath,
			options: {
				preview: false,
				preserveFocus: false,
				startLine: definitionLine,
				startCharacter: 1,
			},
		})
		console.log(`Successfully opened ${filePath} at Flash_Layout definition (line ${definitionLine})`)
	} catch (error) {
		const errorMsg = error instanceof Error ? error.message : String(error)
		HostProvider.window.showMessage({
			type: ShowMessageType.ERROR,
			message: `Failed to open flash config file: ${errorMsg}`,
		})
	}
}

/**
 * @param sdkRoot
 * @param icSelection
 * @returns image_name
 */
async function getAppImageName(sdkRoot: string, icSelection: string): Promise<string> {
	const projectDir = path.join(sdkRoot, `${icSelection}_gcc_project`)
	const cmakeFilePath = path.join(projectDir, "CMakeLists.txt")
	const configFilePath = path.join(projectDir, "build", ".config")

	// 1. 读取.config文件
	let configContent = ""
	try {
		configContent = await fs.readFile(configFilePath, "utf-8")
	} catch (error) {
		console.log(`'.config' file not found at ${configFilePath}. Assuming all configs are disabled.`)
	}
	const isConfigSet = (name: string): boolean => configContent.includes(`${name}=y`)

	// 2. 读取 CMakeLists.txt
	let cmakeContent: string
	try {
		cmakeContent = await fs.readFile(cmakeFilePath, "utf-8")
	} catch (error) {
		throw new Error(`CMakeLists.txt not found at ${cmakeFilePath}. Cannot determine flash image name.`)
	}

	// 3. 解析
	let searchScope = cmakeContent

	// 正则表达式，查询Config配置
	const outerConditionRegex = /if\s*\(\s*(CONFIG_[\w_]+)\s*\)\s*([\s\S]*?)\s*else\s*\(\s*\)\s*([\s\S]*?)\s*endif\s*\(\s*\)/i
	const outerMatch = cmakeContent.match(outerConditionRegex)

	if (outerMatch) {
		const configVar = outerMatch[1]
		const ifBlock = outerMatch[2]
		const elseBlock = outerMatch[3]

		console.log(`Found outer conditional block based on: ${configVar}`)
		if (isConfigSet(configVar)) {
			console.log(`'${configVar}' is set. Searching for app_name in 'if' block.`)
			searchScope = ifBlock
		} else {
			console.log(`'${configVar}' is not set. Searching for app_name in 'else' block.`)
			searchScope = elseBlock
		}
	}

	// 在確定的範圍內查找 app_name 的定義
	// Regex: ameba_set_if( <CONFIG_VAR>  app_name  <name_if_true>  p_ELSE  <name_if_false> )
	const appNameRegex = /ameba_set_if\s*\(\s*(CONFIG_[\w_]+)\s+app_name\s+([\w._-]+)\s+p_ELSE\s+([\w._-]+)\s*\)/
	const appNameMatch = searchScope.match(appNameRegex)

	if (appNameMatch) {
		const innerConfigVar = appNameMatch[1]
		const nameIfTrue = appNameMatch[2]
		const nameIfFalse = appNameMatch[3]

		return isConfigSet(innerConfigVar) ? nameIfTrue : nameIfFalse
	}

	// 如果沒有找到 ameba_set_if，嘗試尋找 ameba_firmware_package 的第一個參數（不含變數）
	const firmwarePackageRegex = /ameba_firmware_package\s*\(\s*([\w._-]+)/
	const packageMatch = searchScope.match(firmwarePackageRegex)
	if (packageMatch) {
		return packageMatch[1]
	}

	throw new Error(
		`Could not parse app_name from ${cmakeFilePath}. Check 'ameba_set_if' or 'ameba_firmware_package' definitions.`,
	)
}

export async function amebaFlash(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		// 1. 检查配置
		const sdkRoot = await controller.getAmebaSdkRoot()
		const icSelection = await controller.getAmebaIcSelection()
		const serialPort = await controller.getSelectedAmebaSerialPort()

		if (!sdkRoot) {
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Ameba SDK root directory not configured." })
			return Empty.create({})
		}
		if (!icSelection) {
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Ameba IC not selected." })
			return Empty.create({})
		}
		if (!serialPort) {
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Serial Port not selected." })
			return Empty.create({})
		}

		// 2. 解析 ameba_flashcfg.c
		const flashCfgPath = path.join(sdkRoot, "component", "soc", "usrcfg", icSelection, "ameba_flashcfg.c")
		let parseResult: FlashLayoutParseResult
		try {
			const fileContent = await fs.readFile(flashCfgPath, "utf-8")
			parseResult = parseFlashLayout(fileContent, flashCfgPath)
		} catch (parseError) {
			const userMessage = parseError instanceof Error ? parseError.message : String(parseError)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to process config file: ${userMessage}`,
			})
			return Empty.create({})
		}

		// 3. 检查Flash Layout
		await openFlashCfgFileAtLayoutDefinition(flashCfgPath, parseResult.definitionLine)
		const validationResult = validateFlashLayout(parseResult.layout)
		if (!validationResult.isValid) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Invalid flash layout in ${flashCfgPath}: ${validationResult.error}`,
			})
			return Empty.create({})
		}

		// 4. 获取app固件名
		let appImageName: string
		try {
			appImageName = await getAppImageName(sdkRoot, icSelection)
			console.log(`Successfully parsed app image name: ${appImageName}`)
		} catch (error) {
			const userMessage = error instanceof Error ? error.message : String(error)
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: userMessage })
			return Empty.create({})
		}

		// 5. 烧录目录和命令组合
		const flashProjectDirName = `${icSelection}_gcc_project`
		const flashDir = path.join(sdkRoot, flashProjectDirName)

		// 6. 获取烧录的固件和offset
		const imageTypeToFileName = new Map<string, string>([
			["IMG_BOOT", "km4_boot_all.bin"],
			["IMG_APP_OTA1", appImageName],
		])

		const effectivePort = serialPort.isRemote ? path.basename(serialPort.path) : serialPort.path

		const commandParts: string[] = ["python", "flash.py", "--port", effectivePort]

		if (serialPort.isRemote) {
			const remoteHost = serialPort.host
			const remotePort = 58916
			commandParts.push("--remote-server", remoteHost, "--remote-port", String(remotePort))
		}

		for (const currentRegion of parseResult.layout) {
			const imageFileName = imageTypeToFileName.get(currentRegion.type)

			if (imageFileName) {
				const imagePath = path.join(flashDir, imageFileName)
				if (!(await fileExists(imagePath))) {
					HostProvider.window.showMessage({
						type: ShowMessageType.ERROR,
						message: `Flash image not found: ${imagePath}. Please build the project first.`,
					})
					return Empty.create({})
				}

				try {
					const endAddrNum = parseInt(currentRegion.endAddr, 16)
					const commandEndAddr = `0x${(endAddrNum + 1).toString(16).toUpperCase()}`
					commandParts.push("--image", imageFileName, currentRegion.startAddr, commandEndAddr)
				} catch (e) {
					console.error(
						`Could not calculate end address for ${currentRegion.type} (line ${currentRegion.lineNumber}):`,
						e,
					)
				}
			}
		}

		if (commandParts.length <= 4) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "No burnable image types (like IMG_BOOT, IMG_APP_OTA1) found in the Flash_Layout table.",
			})
			return Empty.create({})
		}

		// 6. 执行烧录命令
		const flashCommand = commandParts.join(" ")
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
