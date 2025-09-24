import { Empty, StringRequest } from "@shared/proto/cline/common"
import * as fs from "fs/promises"
import * as path from "path"
import * as vscode from "vscode" // 導入 vscode 模組
import { EXAMPLE_LOGICAL_SEARCH_PATHS } from "@/shared/amebaInfo"
import type { Controller } from "../index"

export async function amebaUpdateExample(controller: Controller, request: StringRequest): Promise<Empty> {
	const logicalExamplePath = request.value

	// 1. 更新 Controller 中的狀態
	console.log(`[gRPC][Ameba] Updating selected example to: '${logicalExamplePath || "None"}'`)
	await controller.setSelectedAmebaExample(logicalExamplePath)

	// 2. 如果 exampleRelativePath 為空 (使用者選擇了 "None")，則直接返回
	if (!logicalExamplePath) {
		return Empty.create({})
	}

	const sdkRoot = await controller.getAmebaSdkRoot()
	if (!sdkRoot) {
		console.warn("[gRPC][Ameba] SDK root not found. Cannot attempt to open readme.md.")
		return Empty.create({})
	}

	const activeRoots = controller.amebaEnvManager.getActiveExampleRoots()
	const pathParts = logicalExamplePath.split("/")
	const potentialPrefix = pathParts[0]

	let realBaseDir: string | undefined
	let realExampleSubPath: string

	if (potentialPrefix in activeRoots && potentialPrefix !== "example") {
		realBaseDir = activeRoots[potentialPrefix] // 直接從動態映射中獲取真實的根目錄
		realExampleSubPath = pathParts.slice(1).join("/")
	} else {
		// 否則，它屬於預設的 'example' 分類
		realBaseDir = activeRoots["example"]
		realExampleSubPath = logicalExamplePath
	}

	if (!realBaseDir) {
		console.error(`[Ameba] Could not determine a valid base directory for the path: ${logicalExamplePath}`)
		return Empty.create({})
	}

	// 4. 構造 readme.md 的完整路徑
	const readmePath = path.join(sdkRoot, realBaseDir, realExampleSubPath, "README.md")

	// 5. 檢查檔案是否存在，如果存在則打開 Markdown 預覽
	try {
		// 使用 fs.access 檢查檔案可讀性，如果不存在會拋出錯誤
		await fs.access(readmePath, fs.constants.F_OK)

		console.log(`[gRPC][Ameba] Found readme.md at ${readmePath}. Opening in preview mode.`)

		// 創建檔案的 URI
		const readmeUri = vscode.Uri.file(readmePath)

		// 執行 VS Code 內建命令來顯示 Markdown 預覽
		// 這會以預覽分頁打開，並且是渲染後的 Markdown 視圖
		await vscode.commands.executeCommand("markdown.showPreview", readmeUri)
	} catch (error) {
		// 如果 fs.access 失敗 (檔案不存在) 或打開預覽失敗，則在此捕獲
		// 這不是一個嚴重錯誤，所以只在控制台打印日誌即可
		console.log(`[gRPC][Ameba] No readme.md found at ${readmePath}, or failed to open it. Skipping.`)
	}

	return Empty.create({})
}
