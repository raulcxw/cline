import { ShowMessageType } from "@shared/proto/host/window"
import axios from "axios"
import { exec } from "child_process"
import extract from "extract-zip"
import { createWriteStream } from "fs"
import fs from "fs/promises"
import * as os from "os"
import * as path from "path"
import * as tar from "tar"
import * as vscode from "vscode"
import { Controller } from "@/core/controller" // 為了型別提示
import { HostProvider } from "@/hosts/host-provider"
import { AmebaExample, EXAMPLE_LOGICAL_SEARCH_PATHS } from "@/shared/amebaInfo"
import { fileExistsAtPath } from "@/utils/fs"

const AMEBA_SDK_MARKERS = ["Realtek_Disclaimer-2019.pdf", "ameba.bat", "ameba.sh"]
const IGNORED_DIRS = new Set([".git", ".venv", "build"])
export class AmebaEnvManager {
	private controller: Controller
	private prebuiltsReminderTimer: NodeJS.Timeout | undefined
	private isPrebuiltsReminderActive: boolean = false
	private venvReminderTimer: NodeJS.Timeout | undefined
	private isVenvReminderActive: boolean = false

	private activeExampleRoots: { [key: string]: string } = {}

	constructor(controller: Controller) {
		this.controller = controller
	}

	public dispose(): void {
		this.stopPrebuiltsReminder()
		this.stopVenvReminder()
	}

	// --- Public API ---
	public async runDetectionAndSetup(): Promise<void> {
		this.stopPrebuiltsReminder()
		this.stopVenvReminder()

		const response = await HostProvider.workspace.getWorkspacePaths({})
		const workspaceFolders = response.paths
		if (!workspaceFolders || workspaceFolders.length === 0) {
			console.log("[Ameba SDK] No workspace folder open. Skipping auto-detection.")
			await this.controller.setAmebaSdkRoot(undefined)
			await this.controller.setAmebaToolChainEnv(undefined)
			await this.controller.setAmebaIcVariants([])
			await this.controller.setAmebaSdkVersion(undefined)
			await this.controller.postStateToWebview()
			return
		}

		const rootPath = workspaceFolders[0]
		const foundSdkPath = await this.findAmebaSdkRoot(rootPath)

		await this.controller.setAmebaSdkRoot(foundSdkPath)

		if (foundSdkPath) {
			const version = await this.parseAmebaRtosVersion(foundSdkPath)
			const variants = await this.getAmebaIcVariantsFromSdk(foundSdkPath)
			const examples = await this.parseAmebaExamplesRecursively(foundSdkPath)
			await this.controller.setAmebaSdkVersion(version)
			await this.controller.setAmebaIcVariants(variants)
			await this.controller.setAmebaExamples(examples)
			await this.checkAndSetupAmebaToolChainEnv(foundSdkPath)
		} else {
			await this.controller.setAmebaToolChainEnv(undefined)
			await this.controller.setAmebaSdkVersion(undefined)
			await this.controller.setAmebaIcVariants([])
			await this.controller.setAmebaExamples([])
			//HostProvider.window.showMessage({
			//	type: ShowMessageType.WARNING,
			//	message: "Ameba SDK not found in the workspace. Please open an Ameba SDK project or set the path manually.",
			//})
		}
		await this.controller.postStateToWebview()
	}

	// --- Private Implementation Details ---

	private async findAmebaSdkRoot(searchDir: string): Promise<string | undefined> {
		console.log(`[Ameba SDK] Starting search in: ${searchDir}`)
		const queue: string[] = [searchDir]
		const visited = new Set<string>()

		while (queue.length > 0) {
			const currentDir = queue.shift()!
			if (visited.has(currentDir)) {
				continue
			}
			visited.add(currentDir)

			if (await this.isValidAmebaSdkDir(currentDir)) {
				console.log(`[Ameba SDK] Found valid SDK root at: ${currentDir}`)
				return currentDir
			}

			try {
				const entries = await fs.readdir(currentDir, { withFileTypes: true })
				for (const entry of entries) {
					if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) {
						queue.push(path.join(currentDir, entry.name))
					}
				}
			} catch (_error) {
				// 忽略错误
			}
		}

		console.log(`[Ameba SDK] Search finished. No SDK root found in: ${searchDir}`)
		return undefined
	}

	private async isValidAmebaSdkDir(dirPath: string): Promise<boolean> {
		try {
			const checks = AMEBA_SDK_MARKERS.map((markerFile) => fileExistsAtPath(path.join(dirPath, markerFile)))
			const results = await Promise.all(checks)
			return results.every(Boolean)
		} catch (_error) {
			return false
		}
	}

	private async parseAmebaRtosVersion(sdkRoot: string): Promise<string | undefined> {
		const versionFilePath = path.join(sdkRoot, "component", "soc", "common", "include", "ameba_rtos_version.h")
		try {
			if (!(await fileExistsAtPath(versionFilePath))) {
				console.warn(`[Ameba SDK] Version file not found at: ${versionFilePath}`)
				return undefined
			}

			const content = await fs.readFile(versionFilePath, "utf-8")
			const majorMatch = content.match(/#define\s+AMEBA_RTOS_VERSION_MAJOR\s+(\d+)/)
			const minorMatch = content.match(/#define\s+AMEBA_RTOS_VERSION_MINOR\s+(\d+)/)
			const patchMatch = content.match(/#define\s+AMEBA_RTOS_VERSION_PATCH\s+(\d+)/)

			if (majorMatch && minorMatch && patchMatch) {
				const version = `${majorMatch[1]}.${minorMatch[1]}.${patchMatch[1]}`
				console.log(`[Ameba SDK] Parsed SDK version: ${version}`)
				return version
			}

			console.warn(`[Ameba SDK] Could not parse version numbers from ${versionFilePath}`)
			return undefined
		} catch (error) {
			console.error(`[Ameba SDK] Error reading or parsing version file:`, error)
			return undefined
		}
	}

	private async getAmebaIcVariantsFromSdk(sdkRoot: string): Promise<string[]> {
		try {
			const entries = await fs.readdir(sdkRoot, { withFileTypes: true })
			const variants = entries
				.filter((entry) => entry.isDirectory() && entry.name.endsWith("_gcc_project"))
				.map((entry) => entry.name.replace("_gcc_project", ""))
				.sort()

			console.log(`[Ameba SDK] Found IC variants: [${variants.join(", ")}]`)
			return variants
		} catch (error) {
			console.error(`[Ameba SDK] Failed to read IC variants from ${sdkRoot}:`, error)
			return []
		}
	}

	private async checkAndSetupAmebaToolChainEnv(sdkRoot: string): Promise<void> {
		const platform = process.platform
		let scriptName: string,
			urlVarName: string,
			aliyunUrlVarName: string,
			prebuiltDirPrefix: string,
			defaultToolchainDir: string

		if (platform === "win32") {
			scriptName = "ameba.bat"
			urlVarName = "PREBUILTS_WIN_URL"
			aliyunUrlVarName = "PREBUILTS_WIN_URL_ALIYUN"
			prebuiltDirPrefix = "prebuilts-win"
			defaultToolchainDir = "C:\\rtk-toolchain"
		} else if (platform === "linux") {
			scriptName = "ameba.sh"
			urlVarName = "PREBUILTS_LINUX_URL"
			aliyunUrlVarName = "PREBUILTS_LINUX_URL_ALIYUN"
			prebuiltDirPrefix = "prebuilts-linux"
			defaultToolchainDir = "/opt/rtk-toolchain"
		} else {
			console.log(`[Ameba Env] Skipping PreBuilts check on unsupported platform: ${platform}.`)
			return
		}

		const scriptPath = path.join(sdkRoot, scriptName)
		if (!(await fileExistsAtPath(scriptPath))) {
			console.warn(`[Ameba Env] ${scriptName} not found in ${sdkRoot}. Cannot check environment.`)
			await this.controller.setAmebaToolChainEnv(undefined)
			return
		}

		try {
			const content = await fs.readFile(scriptPath, "utf-8")
			const parseVar = (varName: string): string | undefined => {
				const regex =
					platform === "win32" ? new RegExp(`set\\s+"?${varName}=(.*?)"?$`, "im") : new RegExp(`^${varName}=(.*)$`, "m")
				const match = content.match(regex)
				return match ? match[1].trim().replace(/['"]/g, "") : undefined
			}

			const prebuiltsVersion = parseVar("PREBUILTS_VERSION")
			const prebuiltsUrl = parseVar(urlVarName)
			const prebuiltsUrlAliyun = parseVar(aliyunUrlVarName)

			if (!prebuiltsVersion || !(prebuiltsUrl || prebuiltsUrlAliyun)) {
				console.error(`[Ameba Env] Could not parse required variables from ${scriptName}.`)
				await this.controller.setAmebaToolChainEnv(undefined)
				return
			}

			const envVarPath = process.env.RTK_TOOLCHAIN_DIR
			const baseToolchainDir = envVarPath || defaultToolchainDir

			console.log(`[Ameba Env] envVarPath: "${envVarPath}" "${defaultToolchainDir}"`)
			let expandedBaseToolchainDir = baseToolchainDir
			if (platform !== "win32" && baseToolchainDir.startsWith("~")) {
				expandedBaseToolchainDir = path.join(os.homedir(), baseToolchainDir.substring(1))
				console.log(`[Ameba Env] Expanded toolchain path from "${baseToolchainDir}" to "${expandedBaseToolchainDir}"`)
			}

			const prebuiltsDir = path.join(expandedBaseToolchainDir, `${prebuiltDirPrefix}-${prebuiltsVersion}`)

			if (await fileExistsAtPath(prebuiltsDir)) {
				console.log(`[Ameba Env] Toolchain Dir found at: ${prebuiltsDir}`)
				this.stopPrebuiltsReminder()
				const venvPath = path.join(sdkRoot, ".venv")
				if (!(await fileExistsAtPath(venvPath))) {
					console.log(`[Ameba Env] Toolchain found, but .venv is missing in ${sdkRoot}.`)
					if (this.isVenvReminderActive) {
						console.log("[Ameba Env] .venv reminder loop is already active. Skipping new prompt.")
						return
					}
					this.isVenvReminderActive = true
					console.log("[Ameba Env] Starting .venv setup reminder loop.")
					await this.promptAndRemindToSetupVenv(sdkRoot, baseToolchainDir, prebuiltsDir, platform)
				} else {
					console.log(`[Ameba Env] Toolchain and .venv found. Environment is ready.`)
					this.stopVenvReminder()
					await this.controller.setAmebaToolChainEnv(baseToolchainDir)
				}
			} else {
				console.log(`[Ameba Env] Toolchain Dir not found at: ${prebuiltsDir}.`)
				await this.controller.setAmebaToolChainEnv(undefined)
				if (this.isPrebuiltsReminderActive) {
					console.log("[Ameba Env] Reminder loop is already active. Skipping new prompt.")
					return
				}
				this.isPrebuiltsReminderActive = true
				console.log("[Ameba Env] Starting prebuilts installation reminder loop.")
				const urls: string[] = []
				if (prebuiltsUrl) {
					//urls.push(prebuiltsUrl)
				}
				if (prebuiltsUrlAliyun) {
					urls.push(prebuiltsUrlAliyun)
				}
				this.promptAndRemindToInstallPrebuilts(
					prebuiltsVersion,
					expandedBaseToolchainDir,
					urls,
					prebuiltsDir,
					sdkRoot,
					platform,
				)
			}
		} catch (error) {
			console.error(`Error checking Ameba SDK toolchain for ${platform}:`, error)
			HostProvider.window.showMessage({ type: ShowMessageType.ERROR, message: "Failed to check Ameba SDK toolchain." })
			await this.controller.setAmebaToolChainEnv(undefined)
		}
	}

	public stopPrebuiltsReminder(): void {
		if (this.prebuiltsReminderTimer) {
			clearTimeout(this.prebuiltsReminderTimer)
			this.prebuiltsReminderTimer = undefined
		}
		if (this.isPrebuiltsReminderActive) {
			this.isPrebuiltsReminderActive = false
			console.log("[Ameba Env] Prebuilts installation reminder loop stopped.")
		}
	}

	public stopVenvReminder(): void {
		if (this.venvReminderTimer) {
			clearTimeout(this.venvReminderTimer)
			this.venvReminderTimer = undefined
		}
		if (this.isVenvReminderActive) {
			this.isVenvReminderActive = false
			console.log("[Ameba Env] Python .venv setup reminder loop stopped.")
		}
	}

	private async promptAndRemindToInstallPrebuilts(
		version: string,
		baseToolchainDir: string,
		urls: string[],
		finalDirPath: string,
		sdkRoot: string,
		platform: NodeJS.Platform,
	): Promise<void> {
		if (!this.isPrebuiltsReminderActive) {
			return
		}
		if (await fileExistsAtPath(finalDirPath)) {
			console.log("[Ameba Env] Prebuilts found during reminder check. Stopping loop.")
			this.stopPrebuiltsReminder()
			await this.checkAndSetupAmebaToolChainEnv(sdkRoot)
			return
		}
		const response = await HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: `Ameba Prebuilts (v${version}) is not found. Do you want to download and install it to ${baseToolchainDir}?`,
			options: {
				modal: false,
				items: ["Install Now"],
			},
		})
		if (response.selectedOption === "Install Now") {
			this.stopPrebuiltsReminder()
			await this.downloadAndInstallPrebuilts(urls, baseToolchainDir, finalDirPath, sdkRoot, platform)
		} else {
			if (this.isPrebuiltsReminderActive) {
				console.log("[Ameba Env] User dismissed the prompt. Will remind again in 20 seconds.")
				if (this.prebuiltsReminderTimer) {
					clearTimeout(this.prebuiltsReminderTimer)
				}
				this.prebuiltsReminderTimer = setTimeout(
					() =>
						this.promptAndRemindToInstallPrebuilts(version, baseToolchainDir, urls, finalDirPath, sdkRoot, platform),
					20_000,
				)
			}
		}
	}

	private async promptAndRemindToSetupVenv(
		sdkRoot: string,
		baseToolchainDir: string,
		finalPrebuiltsPath: string,
		platform: NodeJS.Platform,
	): Promise<void> {
		if (!this.isVenvReminderActive) {
			return
		}
		const venvPath = path.join(sdkRoot, ".venv")
		if (await fileExistsAtPath(venvPath)) {
			console.log("[Ameba Env] .venv found during reminder check. Stopping loop.")
			this.stopVenvReminder()
			await this.controller.setAmebaToolChainEnv(baseToolchainDir)
			return
		}
		const response = await HostProvider.window.showMessage({
			type: ShowMessageType.INFORMATION,
			message: "Python virtual environment (.venv) is not found in Ameba SDK folder.",
			options: {
				modal: false,
				detail: "This is required for building and other tasks. Would you like to set it up now?",
				items: ["Setup Now"],
			},
		})
		if (response.selectedOption === "Setup Now") {
			this.stopVenvReminder()
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Setting up Python Environment",
						cancellable: true,
					},
					async (progress, token) => {
						await this.setupPythonEnvironment(sdkRoot, finalPrebuiltsPath, platform, progress, token)
					},
				)
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: "Ameba Python virtual environment created successfully.",
				})
				await this.controller.setAmebaToolChainEnv(baseToolchainDir)
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error)
				console.error("Failed to setup Ameba Python environment:", errorMessage)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: `Failed to create Ameba Python virtual environment: ${errorMessage}`,
				})
				if (!this.isVenvReminderActive) {
					this.isVenvReminderActive = true
					this.promptAndRemindToSetupVenv(sdkRoot, baseToolchainDir, finalPrebuiltsPath, platform)
				}
			}
		} else {
			if (this.isVenvReminderActive) {
				console.log("[Ameba Env] User dismissed the .venv setup prompt. Will remind again in 20 seconds.")
				if (this.venvReminderTimer) {
					clearTimeout(this.venvReminderTimer)
				}
				this.venvReminderTimer = setTimeout(
					() => this.promptAndRemindToSetupVenv(sdkRoot, baseToolchainDir, finalPrebuiltsPath, platform),
					20_000,
				)
			}
		}
	}

	private async downloadAndInstallPrebuilts(
		urls: string[],
		targetUnzipDir: string,
		finalDirPath: string,
		sdkRoot: string,
		platform: NodeJS.Platform,
	): Promise<void> {
		let lastError: Error | undefined
		const isWindows = platform === "win32"
		for (const url of urls) {
			try {
				await vscode.window.withProgress(
					{
						location: vscode.ProgressLocation.Notification,
						title: "Installing Ameba Environment",
						cancellable: true,
					},
					async (progress, token) => {
						token.onCancellationRequested(() => console.log("User cancelled the environment installation."))
						progress.report({ message: `Downloading from ${new URL(url).hostname}...`, increment: 0 })
						const tempDir = await this.controller.ensureCacheDirectoryExists()
						const archiveFileName = path.basename(url)
						const tempArchivePath = path.join(tempDir, archiveFileName)
						const writer = createWriteStream(tempArchivePath)
						let lastDownloadPercent = 0
						const response = await axios({
							method: "get",
							url: url,
							responseType: "stream",
							onDownloadProgress: (e) => {
								if (e.total && !token.isCancellationRequested) {
									const percent = Math.floor((e.loaded / e.total) * 50)
									const increment = percent - lastDownloadPercent
									if (increment > 0) {
										const speed = e.rate ? `${(e.rate / 1024 / 1024).toFixed(2)} MB/s` : ""
										progress.report({ increment, message: `Downloading... ${speed}` })
										lastDownloadPercent = percent
									}
								}
							},
						})
						response.data.pipe(writer)
						await new Promise<void>((resolve, reject) => {
							writer.on("finish", resolve)
							writer.on("error", reject)
							token.onCancellationRequested(() => {
								writer.close()
								reject(new Error("Download cancelled by user."))
							})
						})
						if (token.isCancellationRequested) {
							await fs.unlink(tempArchivePath).catch(() => {})
							return
						}
						progress.report({ increment: 0, message: `Extracting ${archiveFileName}...` })
						await fs.mkdir(targetUnzipDir, { recursive: true })
						if (archiveFileName.endsWith(".zip")) {
							await extract(tempArchivePath, { dir: targetUnzipDir })
						} else if (archiveFileName.endsWith(".tar.gz")) {
							await tar.x({ file: tempArchivePath, cwd: targetUnzipDir })
						} else {
							throw new Error(`Unsupported archive format: ${archiveFileName}`)
						}
						progress.report({ increment: 20, message: "Extraction complete." })
						await fs.unlink(tempArchivePath)
						if (token.isCancellationRequested) {
							return
						}
						if (!isWindows) {
							progress.report({ message: "Setting permissions..." })
							console.log(`[Ameba Env] Applying executable permissions to ${finalDirPath}`)
							const channel = vscode.window.createOutputChannel("Ameba Environment Setup")
							channel.show(true)
							try {
								await this.executeCommandInOutputChannel(`chmod -R +x "${finalDirPath}"`, channel)
							} catch (permError) {
								console.error("Failed to set permissions, continuing anyway.", permError)
								channel.appendLine(
									`[Warning] Failed to set permissions for ${finalDirPath}. You may need to set them manually.`,
								)
							}
						}
						await this.setupPythonEnvironment(sdkRoot, finalDirPath, platform, progress, token)
						if (token.isCancellationRequested) {
							return
						}
						HostProvider.window.showMessage({
							type: ShowMessageType.INFORMATION,
							message: `Ameba toolchain and Python environment installed successfully at ${finalDirPath}`,
						})
						await this.controller.setAmebaToolChainEnv(targetUnzipDir)
					},
				)
				return
			} catch (error) {
				console.error(`Failed to download or install from ${url}:`, error)
				lastError = error instanceof Error ? error : new Error(String(error))
			}
		}
		if (lastError) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `Failed to install Ameba toolchain. Error: ${lastError.message}`,
			})
			await this.controller.setAmebaToolChainEnv(undefined)
			if (!this.isPrebuiltsReminderActive) {
				this.isPrebuiltsReminderActive = true
				const version = path.basename(finalDirPath).split("-").pop() || ""
				this.promptAndRemindToInstallPrebuilts(version, targetUnzipDir, urls, finalDirPath, sdkRoot, platform)
			}
		}
	}

	private async setupPythonEnvironment(
		sdkRoot: string,
		toolchainDir: string,
		platform: NodeJS.Platform,
		progress: vscode.Progress<{ message?: string; increment?: number }>,
		token: vscode.CancellationToken,
	): Promise<void> {
		const channel = vscode.window.createOutputChannel("Ameba Environment Setup")
		channel.show(true)

		const isWindows = platform === "win32"
		const venvPath = path.join(sdkRoot, ".venv")
		const requirementsPath = path.join(sdkRoot, "tools", "requirements.txt")

		let pythonExecutablePath: string

		if (isWindows) {
			const pythonFolderName = "python3"
			const pythonExeName = "python.exe"
			pythonExecutablePath = path.join(toolchainDir, pythonFolderName, pythonExeName)

			channel.appendLine(`[Info] Platform is Windows. Verifying portable Python at: ${pythonExecutablePath}`)
			if (!(await fileExistsAtPath(pythonExecutablePath))) {
				throw new Error(
					`Portable Python not found at: ${pythonExecutablePath}. Please ensure the toolchain is installed correctly.`,
				)
			}
			channel.appendLine(`[Info] Portable Python found.`)
		} else {
			pythonExecutablePath = "python3"
			channel.appendLine(`[Info] Platform is ${platform}. Attempting to use system command: '${pythonExecutablePath}'`)

			try {
				await this.executeCommandInOutputChannel(`${pythonExecutablePath} --version`, channel)
				channel.appendLine(`[Info] System command '${pythonExecutablePath}' is available.`)
			} catch (_error) {
				channel.appendLine(`[Error] System command '${pythonExecutablePath}' not found or failed to execute.`)
				channel.appendLine(
					`[Info] Please make sure Python 3 is installed and '${pythonExecutablePath}' is in your system's PATH.`,
				)
				throw new Error(`System command '${pythonExecutablePath}' is not available. Please install Python 3.`)
			}
		}

		if (!(await fileExistsAtPath(requirementsPath))) {
			channel.appendLine(`[Warning] requirements.txt not found at: ${requirementsPath}. Skipping dependency installation.`)
			return
		}

		if (token.isCancellationRequested) {
			return
		}

		progress.report({ increment: 15, message: "Cleaning up old environment..." })
		channel.appendLine(`\n[Step 1/3] Removing existing .venv directory at ${venvPath}...`)
		if (await fileExistsAtPath(venvPath)) {
			await fs.rm(venvPath, { recursive: true, force: true })
		}
		channel.appendLine("Cleanup complete.")

		if (token.isCancellationRequested) {
			return
		}

		progress.report({ increment: 25, message: "Creating Python virtual environment..." })
		channel.appendLine("\n[Step 2/3] Creating new Python virtual environment...")
		const venvModuleName = isWindows ? "virtualenv" : "venv"
		const createVenvCommand = `"${pythonExecutablePath}" -m ${venvModuleName} "${venvPath}"`
		await this.executeCommandInOutputChannel(createVenvCommand, channel)

		if (token.isCancellationRequested) {
			return
		}

		progress.report({ increment: 20, message: "Installing dependencies..." })
		channel.appendLine("\n[Step 3/3] Installing dependencies from requirements.txt...")
		const venvPythonPath = path.join(venvPath, isWindows ? "Scripts" : "bin", "python")
		const installDepsCommand = `"${venvPythonPath}" -m pip install -r "${requirementsPath}"`
		await this.executeCommandInOutputChannel(installDepsCommand, channel)

		channel.appendLine("\nPython virtual environment setup complete!")
		progress.report({ increment: 5, message: "Setup complete!" })
	}

	private executeCommandInOutputChannel(
		command: string,
		channel: vscode.OutputChannel,
		options?: { cwd?: string },
	): Promise<void> {
		return new Promise((resolve, reject) => {
			channel.appendLine(`> Executing: ${command}` + (options?.cwd ? ` in ${options.cwd}` : ""))
			const process = exec(command, options)
			process.stdout?.on("data", (data) => channel.append(data.toString()))
			process.stderr?.on("data", (data) => channel.append(data.toString()))
			process.on("close", (code) => {
				if (code === 0) {
					channel.appendLine(`> Command finished successfully.\n`)
					resolve()
				} else {
					const errorMsg = `> Command failed with exit code ${code}. Check output for details.`
					channel.appendLine(errorMsg)
					reject(new Error(errorMsg))
				}
			})
			process.on("error", (err) => {
				channel.appendLine(`> Failed to start command: ${err.message}`)
				reject(err)
			})
		})
	}

	public getActiveExampleRoots(): { [key: string]: string } {
		return this.activeExampleRoots
	}

	private async parseAmebaExamplesRecursively(sdkRoot: string): Promise<AmebaExample[]> {
		console.log("[Ameba SDK] Starting dynamic example parsing...")
		this.activeExampleRoots = {} // 每次解析前清空
		const collectedExamples: AmebaExample[] = []

		// --- 階段一：探測並建立 activeExampleRoots 映射 ---
		const logicalCategories = Object.keys(EXAMPLE_LOGICAL_SEARCH_PATHS)

		for (const category of logicalCategories) {
			if (category === "example") continue // 'example' 稍後特殊處理

			for (const searchPath of EXAMPLE_LOGICAL_SEARCH_PATHS[category]) {
				const fullPath = path.join(sdkRoot, searchPath)
				if (await fileExistsAtPath(fullPath)) {
					this.activeExampleRoots[category] = searchPath // 找到並記錄
					console.log(`[Ameba SDK] Found active root for '${category}': ${searchPath}`)
					break // 找到後不再查找此分類的其他路徑
				}
			}
		}
		// 'example' 分類永遠存在
		this.activeExampleRoots["example"] = EXAMPLE_LOGICAL_SEARCH_PATHS["example"][0]

		console.log("[Ameba SDK] Active example roots detected:", this.activeExampleRoots)

		// --- 階段二：根據映射結果，掃描並收集範例 ---

		// 遞迴輔助函式（與之前版本類似，但現在基於 activeExampleRoots）
		const findExamples = async (currentDir: string, logicalPrefix: string, relativePathParts: string[]): Promise<void> => {
			// ... (這部分邏輯與上個版本的實作完全相同)
			const isExample = await fileExistsAtPath(path.join(currentDir, "CMakeLists.txt"))
			if (isExample) {
				const pathParts = logicalPrefix ? [logicalPrefix, ...relativePathParts] : relativePathParts
				collectedExamples.push({
					name: relativePathParts[relativePathParts.length - 1],
					path: pathParts.join("/"),
					category: pathParts.slice(0, -1).join("/"),
				})
			}
			try {
				const entries = await fs.readdir(currentDir, { withFileTypes: true })
				for (const entry of entries) {
					if (entry.isDirectory()) {
						await findExamples(path.join(currentDir, entry.name), logicalPrefix, [...relativePathParts, entry.name])
					}
				}
			} catch (error) {
				/* ... */
			}
		}

		// [關鍵] 找出在舊版 SDK 中被 'example' 目錄包含的分類
		const claimedSubDirs = new Set<string>()
		for (const category in this.activeExampleRoots) {
			const activePath = this.activeExampleRoots[category]
			if (activePath.startsWith("component/example/")) {
				// e.g., 'component/example/audio' -> 'audio'
				const subDirName = activePath.split("/")[2]
				claimedSubDirs.add(subDirName)
			}
		}

		// 根據探測結果執行掃描
		const scanTasks = Object.entries(this.activeExampleRoots).map(async ([category, activePath]) => {
			const examplesBasePath = path.join(sdkRoot, activePath)
			const prefixToUse = category === "example" ? "" : category

			try {
				const topLevelEntries = await fs.readdir(examplesBasePath, { withFileTypes: true })
				for (const entry of topLevelEntries) {
					// [關鍵] 如果是掃描 'example' 根目錄，則跳過已被其他分類認領的子目錄
					if (category === "example" && claimedSubDirs.has(entry.name)) {
						console.log(
							`[Ameba SDK] Skipping '${entry.name}' in 'component/example' as it is claimed by another category.`,
						)
						continue
					}

					if (entry.isDirectory()) {
						await findExamples(path.join(examplesBasePath, entry.name), prefixToUse, [entry.name])
					}
				}
			} catch (error) {
				/* ... */
			}
		})

		await Promise.all(scanTasks)

		console.log(`[Ameba SDK] Found ${collectedExamples.length} compatible examples.`)
		return collectedExamples.sort((a, b) => a.path.localeCompare(b.path))
	}
}
