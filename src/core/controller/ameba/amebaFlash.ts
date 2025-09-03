import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import * as fs from "fs/promises"
import * as path from "path"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType, ShowTextDocumentOptions, ShowTextDocumentRequest } from "@/shared/proto/host/window"
import type { Controller } from "../index"

/**
 * Defines the structure for a parsed flash memory region.
 */
interface FlashRegionInfo {
	type: string
	startAddr: string
	endAddr: string
	lineNumber: number // 该条目在文件中的行号（1-based）
}

/**
 * 解析结果接口（新增表格定义行号）
 */
interface FlashLayoutParseResult {
	layout: FlashRegionInfo[]
	definitionLine: number // Flash_Layout表格定义所在的行号（1-based）
}

/**
 * 精确解析const FlashLayoutInfo_TypeDef Flash_Layout[]表格
 * @param fileContent C文件内容
 * @param filePath 文件路径（用于错误提示）
 * @returns 解析结果（包含表格内容和定义行号）
 */
function parseFlashLayout(fileContent: string, filePath: string): FlashLayoutParseResult {
	const result: FlashLayoutParseResult = {
		layout: [],
		definitionLine: -1,
	}
	const lines = fileContent.split(/\r?\n/)

	// 1. 先收集所有符合条件的Flash_Layout定义行（兼容有无const、多个定义）
	const targetDefinitionRegex = /^\s*(const\s+)?FlashLayoutInfo_TypeDef\s+Flash_Layout/
	const layoutDefinitions: { lineNumber: number; lineIndex: number }[] = [] // 存储所有定义行的“行号”和“数组索引”
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]
		if (targetDefinitionRegex.test(line)) {
			layoutDefinitions.push({
				lineNumber: i + 1, // 行号（1-based）
				lineIndex: i, // 数组索引（0-based，用于后续定位解析起点）
			})
		}
	}

	// 2. 确定目标定义行：1个则选唯一，≥2个则选最后一个（第二个）
	if (layoutDefinitions.length === 0) {
		throw new Error(`Could not find 'FlashLayoutInfo_TypeDef Flash_Layout' definition in ${filePath}`)
	}
	const targetDef = layoutDefinitions.length >= 2 ? layoutDefinitions[layoutDefinitions.length - 1] : layoutDefinitions[0]
	result.definitionLine = targetDef.lineNumber // 记录目标行号

	// 3. 从目标定义行开始解析表格内容（保留原解析逻辑）
	let inTargetLayout = false
	let braceCount = 0 // 用于处理嵌套大括号的情况
	for (let i = targetDef.lineIndex; i < lines.length; i++) {
		// 从目标定义行的索引开始遍历
		const lineNumber = i + 1 // 行号从1开始
		const line = lines[i]

		// 找到目标表格定义行（触发解析）
		if (!inTargetLayout && targetDefinitionRegex.test(line)) {
			inTargetLayout = true
			braceCount = 1 // 已找到一个起始大括号（定义行包含“{”）
			continue
		}

		// 解析目标表格内部内容
		if (inTargetLayout) {
			// 统计大括号数量，处理嵌套情况
			braceCount += (line.match(/{/g) || []).length
			braceCount -= (line.match(/}/g) || []).length

			// 匹配表格条目：{IMG_BOOT, 0x08000000, 0x08013FFF}
			const entryRegex = /\{\s*(\w+)\s*,\s*(0x[0-9a-fA-F]+)\s*,\s*(0x[0-9a-fA-F]+)\s*\}/g
			let match: RegExpExecArray | null

			while ((match = entryRegex.exec(line)) !== null) {
				// 忽略终止条目
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

			// 表格结束（大括号闭合）
			if (braceCount === 0) {
				inTargetLayout = false
				break // 只解析目标表格
			}
		}
	}

	// 验证解析结果
	if (result.layout.length === 0) {
		throw new Error(`No valid entries found in 'Flash_Layout' table (line ${result.definitionLine}) in ${filePath}`)
	}

	return result
}

/**
 * 验证解析的flash布局
 */
function validateFlashLayout(layout: FlashRegionInfo[]): { isValid: boolean; error?: string } {
	// 过滤占位条目
	const validRegions = layout.filter((region) => !(region.startAddr === "0xFFFFFFFF" && region.endAddr === "0xFFFFFFFF"))

	// 按起始地址排序
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

		// 起始地址必须小于结束地址
		if (startNum >= endNum) {
			return {
				isValid: false,
				error: `Validation failed for region ${region.type} (line ${region.lineNumber}): Start address (${region.startAddr}) must be less than end address (${region.endAddr}).`,
			}
		}

		// 4K对齐检查
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

		// 检查区域重叠
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

/**
 * 打开ameba_flashcfg.c并定位到Flash_Layout表格定义行
 */
async function openFlashCfgFileAtLayoutDefinition(filePath: string, definitionLine: number) {
	try {
		await HostProvider.window.showTextDocument({
			path: filePath,
			options: {
				preview: false,
				preserveFocus: false,
				startLine: definitionLine, // 定位到表格定义行
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

export async function amebaFlash(controller: Controller, _request: EmptyRequest): Promise<Empty> {
	try {
		// 检查配置
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

		// 读取并解析配置文件
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

		// 验证布局
		const validationResult = validateFlashLayout(parseResult.layout)
		if (!validationResult.isValid) {
			await openFlashCfgFileAtLayoutDefinition(flashCfgPath, parseResult.definitionLine)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Invalid flash layout in ${flashCfgPath}: ${validationResult.error}`,
			})
			return Empty.create({})
		}

		// 验证成功，打开文件并定位到表格定义行
		await openFlashCfgFileAtLayoutDefinition(flashCfgPath, parseResult.definitionLine)
		console.log(
			`Flash layout parsed successfully. Opened ${path.basename(flashCfgPath)} at Flash_Layout definition (line ${parseResult.definitionLine}).`,
		)

		// 构建烧录命令
		const imageTypeToFileName = new Map<string, string>([
			["IMG_BOOT", "km4_boot_all.bin"],
			["IMG_APP_OTA1", "km0_km4_app.bin"],
		])

		const commandParts: string[] = ["python", "flash.py", "--port", serialPort]

		for (const currentRegion of parseResult.layout) {
			const imageFileName = imageTypeToFileName.get(currentRegion.type)

			if (imageFileName) {
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

		const flashCommand = commandParts.join(" ")

		// 执行烧录命令
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
