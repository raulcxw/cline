import { Anthropic } from "@anthropic-ai/sdk"
import { buildApiHandler } from "@core/api"
import { cleanupLegacyCheckpoints } from "@integrations/checkpoints/CheckpointMigration"
import { downloadTask } from "@integrations/misc/export-markdown"
import { TerminalManager } from "@integrations/terminal/TerminalManager"
import { ClineAccountService } from "@services/account/ClineAccountService"
import { McpHub } from "@services/mcp/McpHub"
import { ApiProvider, ModelInfo } from "@shared/api"
import { ChatContent } from "@shared/ChatContent"
import { ExtensionState, Platform } from "@shared/ExtensionMessage"
import { HistoryItem } from "@shared/HistoryItem"
import { McpMarketplaceCatalog } from "@shared/mcp"
import { ShowMessageType } from "@shared/proto/host/window"
import { Mode } from "@shared/storage/types"
import { TelemetrySetting } from "@shared/TelemetrySetting"
import { UserInfo } from "@shared/UserInfo"
import { fileExistsAtPath } from "@utils/fs"
import axios from "axios"
import { exec } from "child_process"
import extract from "extract-zip"
/* realtek ameba add start*/
import { createWriteStream } from "fs"
import fs from "fs/promises"
import * as os from "os"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as tar from "tar"
import * as vscode from "vscode"
import { clineEnvConfig } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import { AuthService } from "@/services/auth/AuthService"
import { PostHogClientProvider, telemetryService } from "@/services/posthog/PostHogClientProvider"
import { AmebaRemoteServer } from "@/shared/amebaInfo"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getCwd, getDesktopDir } from "@/utils/path"
import { CacheService, PersistenceErrorEvent } from "../storage/CacheService"
import { ensureMcpServersDirectoryExists, ensureSettingsDirectoryExists, GlobalFileNames } from "../storage/disk"
import { Task } from "../task"
import { AmebaSerialPort, type PortInfo } from "./ameba/amebaSerialPort"
import { sendMcpMarketplaceCatalogEvent } from "./mcp/subscribeToMcpMarketplaceCatalog"
import { sendStateUpdate } from "./state/subscribeToState"

// [修改] 引入不含 id 的 ServerConfig
//import { ServerConfig as AmebaRemoteServerConfig } from "./ameba/amebaRemoteSerialPort"

// 移除硬编码的IC列表，改为动态获取
const AMEBA_SDK_MARKERS = ["Realtek_Disclaimer-2019.pdf", "ameba.bat", "ameba.sh"]
const IGNORED_DIRS = new Set([".git", ".venv", "build"])
/* realtek ameba add end*/

export class Controller {
	readonly id: string
	private disposables: vscode.Disposable[] = []
	task?: Task

	mcpHub: McpHub
	accountService: ClineAccountService
	authService: AuthService
	readonly cacheService: CacheService

	/* realtek ameba add start*/
	public readonly amebaTerminalManager: TerminalManager
	private serialPortManager: AmebaSerialPort | undefined
	private prebuiltsReminderTimer: NodeJS.Timeout | undefined
	private isPrebuiltsReminderActive: boolean = false
	private venvReminderTimer: NodeJS.Timeout | undefined
	private isVenvReminderActive: boolean = false
	private portRefreshInterval: NodeJS.Timeout | undefined
	/* realtek ameba add end*/

	constructor(
		readonly context: vscode.ExtensionContext,
		id: string,
	) {
		this.id = id

		HostProvider.get().logToChannel("ClineProvider instantiated")
		this.accountService = ClineAccountService.getInstance()
		this.cacheService = new CacheService(context)
		this.authService = AuthService.getInstance(this)

		/* realtek ameba add start*/
		this.amebaTerminalManager = new TerminalManager()
		/* realtek ameba add end*/

		// 初始化缓存服务
		this.cacheService
			.initialize()
			.then(() => {
				this.authService.restoreRefreshTokenAndRetrieveAuthInfo()

				/* realtek ameba add start*/
				console.log("[Controller] CacheService initialized.")

				// [修改] 初始化串口管理器
				this.serialPortManager = new AmebaSerialPort(this.handleSerialPortsChange.bind(this))
				// [修改] 立即將儲存的伺服器列表傳遞給管理器
				this.serialPortManager.updateServerList(this.getAmebaRemoteServers())

				// 1. 插件启动时检测SDK
				this.autoDetectAndSetAmebaSdkRoot()

				// 2. 监听工作区变化
				this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.autoDetectAndSetAmebaSdkRoot()))

				// 3. 启动定期刷新机制
				this.startPeriodicPortRefresh(3000)
				/* realtek ameba add end*/
			})
			.catch((error) => {
				console.error("CRITICAL: Failed to initialize CacheService:", error)
			})

		// 缓存错误处理
		this.cacheService.onPersistenceError = async ({ error }: PersistenceErrorEvent) => {
			console.error("Cache persistence failed, recovering:", error)
			try {
				await this.cacheService.reInitialize()
				await this.postStateToWebview()
				HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: "Saving settings to storage failed.",
				})
			} catch (recoveryError) {
				console.error("Cache recovery failed:", recoveryError)
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: "Failed to save settings. Please restart the extension.",
				})
			}
		}

		this.mcpHub = new McpHub(
			() => ensureMcpServersDirectoryExists(),
			() => ensureSettingsDirectoryExists(this.context),
			this.context.extension?.packageJSON?.version ?? "1.0.0",
			telemetryService,
		)

		// 清理旧检查点
		cleanupLegacyCheckpoints(this.context.globalStorageUri.fsPath).catch((error) => {
			console.error("Failed to cleanup legacy checkpoints:", error)
		})
	}

	async getCurrentMode(): Promise<Mode> {
		return this.cacheService.getGlobalStateKey("mode")
	}

	async dispose() {
		await this.clearTask()
		while (this.disposables.length) {
			const x = this.disposables.pop()
			if (x) {
				x.dispose()
			}
		}
		this.mcpHub.dispose()

		/* realtek ameba add start*/
		this.amebaTerminalManager.disposeAll && this.amebaTerminalManager.disposeAll()
		this.serialPortManager?.dispose() // 释放串口管理器资源
		this.stopPrebuiltsReminder()
		this.stopVenvReminder()
		if (this.portRefreshInterval) {
			clearInterval(this.portRefreshInterval)
		}
		/* realtek ameba add end*/

		console.error("Controller disposed")
	}

	// 认证相关方法
	async handleSignOut() {
		try {
			this.cacheService.setSecret("clineAccountId", undefined)
			this.cacheService.setGlobalState("userInfo", undefined)

			const apiConfiguration = this.cacheService.getApiConfiguration()
			const updatedConfig = {
				...apiConfiguration,
				planModeApiProvider: "openrouter" as ApiProvider,
				actModeApiProvider: "openrouter" as ApiProvider,
			}
			this.cacheService.setApiConfiguration(updatedConfig)

			await this.postStateToWebview()
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Successfully logged out of Cline",
			})
		} catch (_error) {
			HostProvider.window.showMessage({
				type: ShowMessageType.INFORMATION,
				message: "Logout failed",
			})
		}
	}

	async setUserInfo(info?: UserInfo) {
		this.cacheService.setGlobalState("userInfo", info)
	}

	async initTask(task?: string, images?: string[], files?: string[], historyItem?: HistoryItem) {
		await this.clearTask()

		const apiConfiguration = this.cacheService.getApiConfiguration()
		const autoApprovalSettings = this.cacheService.getGlobalStateKey("autoApprovalSettings")
		const browserSettings = this.cacheService.getGlobalStateKey("browserSettings")
		const focusChainSettings = this.cacheService.getGlobalStateKey("focusChainSettings")
		const focusChainFeatureFlagEnabled = this.cacheService.getGlobalStateKey("focusChainFeatureFlagEnabled")
		const preferredLanguage = this.cacheService.getGlobalStateKey("preferredLanguage")
		const openaiReasoningEffort = this.cacheService.getGlobalStateKey("openaiReasoningEffort")
		const mode = this.cacheService.getGlobalStateKey("mode")
		const shellIntegrationTimeout = this.cacheService.getGlobalStateKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.cacheService.getGlobalStateKey("terminalReuseEnabled")
		const terminalOutputLineLimit = this.cacheService.getGlobalStateKey("terminalOutputLineLimit")
		const defaultTerminalProfile = this.cacheService.getGlobalStateKey("defaultTerminalProfile")
		const enableCheckpointsSetting = this.cacheService.getGlobalStateKey("enableCheckpointsSetting")
		const isNewUser = this.cacheService.getGlobalStateKey("isNewUser")
		const taskHistory = this.cacheService.getGlobalStateKey("taskHistory")
		const strictPlanModeEnabled = this.cacheService.getGlobalStateKey("strictPlanModeEnabled")
		const useAutoCondense = this.cacheService.getGlobalStateKey("useAutoCondense")

		const NEW_USER_TASK_COUNT_THRESHOLD = 10

		if (isNewUser && !historyItem && taskHistory && taskHistory.length >= NEW_USER_TASK_COUNT_THRESHOLD) {
			this.cacheService.setGlobalState("isNewUser", false)
			await this.postStateToWebview()
		}

		if (autoApprovalSettings) {
			const updatedAutoApprovalSettings = {
				...autoApprovalSettings,
				version: (autoApprovalSettings.version ?? 1) + 1,
			}
			this.cacheService.setGlobalState("autoApprovalSettings", updatedAutoApprovalSettings)
		}

		const effectiveFocusChainSettings = {
			...(focusChainSettings || { enabled: true, remindClineInterval: 6 }),
			enabled: Boolean(focusChainSettings?.enabled) && Boolean(focusChainFeatureFlagEnabled),
		}

		this.task = new Task(
			this,
			this.mcpHub,
			(historyItem) => this.updateTaskHistory(historyItem),
			() => this.postStateToWebview(),
			(taskId) => this.reinitExistingTaskFromId(taskId),
			() => this.cancelTask(),
			apiConfiguration,
			autoApprovalSettings,
			browserSettings,
			effectiveFocusChainSettings,
			preferredLanguage,
			openaiReasoningEffort,
			mode,
			strictPlanModeEnabled ?? true,
			useAutoCondense ?? true,
			shellIntegrationTimeout,
			terminalReuseEnabled ?? true,
			terminalOutputLineLimit ?? 500,
			defaultTerminalProfile ?? "default",
			enableCheckpointsSetting ?? true,
			await getCwd(getDesktopDir()),
			this.cacheService,
			task,
			images,
			files,
			historyItem,
		)
	}

	async reinitExistingTaskFromId(taskId: string) {
		const history = await this.getTaskWithId(taskId)
		if (history) {
			await this.initTask(undefined, undefined, undefined, history.historyItem)
		}
	}

	async updateTelemetrySetting(telemetrySetting: TelemetrySetting) {
		this.cacheService.setGlobalState("telemetrySetting", telemetrySetting)
		const isOptedIn = telemetrySetting !== "disabled"
		telemetryService.updateTelemetryState(isOptedIn)
		await this.postStateToWebview()
	}

	async togglePlanActMode(modeToSwitchTo: Mode, chatContent?: ChatContent): Promise<boolean> {
		const didSwitchToActMode = modeToSwitchTo === "act"

		this.cacheService.setGlobalState("mode", modeToSwitchTo)

		telemetryService.captureModeSwitch(this.task?.ulid ?? "0", modeToSwitchTo)

		if (this.task) {
			const apiConfiguration = this.cacheService.getApiConfiguration()
			this.task.api = buildApiHandler({ ...apiConfiguration, ulid: this.task.ulid }, modeToSwitchTo)
		}

		await this.postStateToWebview()

		if (this.task) {
			this.task.updateMode(modeToSwitchTo)
			if (this.task.taskState.isAwaitingPlanResponse && didSwitchToActMode) {
				this.task.taskState.didRespondToPlanAskBySwitchingMode = true
				await this.task.handleWebviewAskResponse(
					"messageResponse",
					chatContent?.message || "PLAN_MODE_TOGGLE_RESPONSE",
					chatContent?.images || [],
					chatContent?.files || [],
				)
				return true
			} else {
				this.cancelTask()
				return false
			}
		}

		return false
	}

	async cancelTask() {
		if (this.task) {
			const { historyItem } = await this.getTaskWithId(this.task.taskId)
			try {
				await this.task.abortTask()
			} catch (error) {
				console.error("Failed to abort task", error)
			}
			await pWaitFor(
				() =>
					this.task === undefined ||
					this.task.taskState.isStreaming === false ||
					this.task.taskState.didFinishAbortingStream ||
					this.task.taskState.isWaitingForFirstChunk,
				{
					timeout: 3_000,
				},
			).catch(() => {
				console.error("Failed to abort task")
			})
			if (this.task) {
				this.task.taskState.abandoned = true
			}
			await this.initTask(undefined, undefined, undefined, historyItem)
		}
	}

	async handleAuthCallback(customToken: string, provider: string | null = null) {
		try {
			await this.authService.handleAuthCallback(customToken, provider ? provider : "google")

			const clineProvider: ApiProvider = "cline"

			const planActSeparateModelsSetting = this.cacheService.getGlobalStateKey("planActSeparateModelsSetting")
			const currentMode = await this.getCurrentMode()
			const currentApiConfiguration = this.cacheService.getApiConfiguration()

			const updatedConfig = { ...currentApiConfiguration }

			if (planActSeparateModelsSetting) {
				if (currentMode === "plan") {
					updatedConfig.planModeApiProvider = clineProvider
				} else {
					updatedConfig.actModeApiProvider = clineProvider
				}
			} else {
				updatedConfig.planModeApiProvider = clineProvider
				updatedConfig.actModeApiProvider = clineProvider
			}

			this.cacheService.setApiConfiguration(updatedConfig)
			this.cacheService.setGlobalState("welcomeViewCompleted", true)

			if (this.task) {
				this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
			}

			await this.postStateToWebview()
		} catch (error) {
			console.error("Failed to handle auth callback:", error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Failed to log in to Cline",
			})
		}
	}

	// MCP Marketplace相关
	private async fetchMcpMarketplaceFromApi(silent: boolean = false): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const response = await axios.get(`${clineEnvConfig.mcpBaseUrl}/marketplace`, {
				headers: {
					"Content-Type": "application/json",
				},
			})

			if (!response.data) {
				throw new Error("Invalid response from MCP marketplace API")
			}

			const catalog: McpMarketplaceCatalog = {
				items: (response.data || []).map((item: any) => ({
					...item,
					githubStars: item.githubStars ?? 0,
					downloadCount: item.downloadCount ?? 0,
					tags: item.tags ?? [],
				})),
			}

			this.cacheService.setGlobalState("mcpMarketplaceCatalog", catalog)
			return catalog
		} catch (error) {
			console.error("Failed to fetch MCP marketplace:", error)
			if (!silent) {
				const errorMessage = error instanceof Error ? error.message : "Failed to fetch MCP marketplace"
				HostProvider.window.showMessage({
					type: ShowMessageType.ERROR,
					message: errorMessage,
				})
			}
			return undefined
		}
	}

	private async fetchMcpMarketplaceFromApiRPC(silent: boolean = false): Promise<McpMarketplaceCatalog | undefined> {
		try {
			const response = await axios.get(`${clineEnvConfig.mcpBaseUrl}/marketplace`, {
				headers: {
					"Content-Type": "application/json",
					"User-Agent": "cline-vscode-extension",
				},
			})

			if (!response.data) {
				throw new Error("Invalid response from MCP marketplace API")
			}

			const catalog: McpMarketplaceCatalog = {
				items: (response.data || []).map((item: any) => ({
					...item,
					githubStars: item.githubStars ?? 0,
					downloadCount: item.downloadCount ?? 0,
					tags: item.tags ?? [],
				})),
			}

			this.cacheService.setGlobalState("mcpMarketplaceCatalog", catalog)
			return catalog
		} catch (error) {
			console.error("Failed to fetch MCP marketplace:", error)
			if (!silent) {
				const errorMessage = error instanceof Error ? error.message : "Failed to fetch MCP marketplace"
				throw new Error(errorMessage)
			}
			return undefined
		}
	}

	async silentlyRefreshMcpMarketplace() {
		try {
			const catalog = await this.fetchMcpMarketplaceFromApi(true)
			if (catalog) {
				await sendMcpMarketplaceCatalogEvent(catalog)
			}
		} catch (error) {
			console.error("Failed to silently refresh MCP marketplace:", error)
		}
	}

	async silentlyRefreshMcpMarketplaceRPC() {
		try {
			return await this.fetchMcpMarketplaceFromApiRPC(true)
		} catch (error) {
			console.error("Failed to silently refresh MCP marketplace (RPC):", error)
			return undefined
		}
	}

	// OpenRouter相关
	async handleOpenRouterCallback(code: string) {
		let apiKey: string
		try {
			const response = await axios.post("https://openrouter.ai/api/v1/auth/keys", { code })
			if (response.data && response.data.key) {
				apiKey = response.data.key
			} else {
				throw new Error("Invalid response from OpenRouter API")
			}
		} catch (error) {
			console.error("Error exchanging code for API key:", error)
			throw error
		}

		const openrouter: ApiProvider = "openrouter"
		const currentMode = await this.getCurrentMode()

		const currentApiConfiguration = this.cacheService.getApiConfiguration()
		const updatedConfig = {
			...currentApiConfiguration,
			planModeApiProvider: openrouter,
			actModeApiProvider: openrouter,
			openRouterApiKey: apiKey,
		}
		this.cacheService.setApiConfiguration(updatedConfig)

		await this.postStateToWebview()
		if (this.task) {
			this.task.api = buildApiHandler({ ...updatedConfig, ulid: this.task.ulid }, currentMode)
		}
	}

	private async ensureCacheDirectoryExists(): Promise<string> {
		const cacheDir = path.join(this.context.globalStorageUri.fsPath, "cache")
		await fs.mkdir(cacheDir, { recursive: true })
		return cacheDir
	}

	// 读取模型缓存
	async readOpenRouterModels(): Promise<Record<string, ModelInfo> | undefined> {
		const openRouterModelsFilePath = path.join(await this.ensureCacheDirectoryExists(), GlobalFileNames.openRouterModels)
		const fileExists = await fileExistsAtPath(openRouterModelsFilePath)
		if (fileExists) {
			const fileContents = await fs.readFile(openRouterModelsFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	}

	async readVercelAiGatewayModels(): Promise<Record<string, ModelInfo> | undefined> {
		const vercelAiGatewayModelsFilePath = path.join(
			await this.ensureCacheDirectoryExists(),
			GlobalFileNames.vercelAiGatewayModels,
		)
		const fileExists = await fileExistsAtPath(vercelAiGatewayModelsFilePath)
		if (fileExists) {
			const fileContents = await fs.readFile(vercelAiGatewayModelsFilePath, "utf8")
			return JSON.parse(fileContents)
		}
		return undefined
	}

	// 任务历史相关
	async getTaskWithId(id: string): Promise<{
		historyItem: HistoryItem
		taskDirPath: string
		apiConversationHistoryFilePath: string
		uiMessagesFilePath: string
		contextHistoryFilePath: string
		taskMetadataFilePath: string
		apiConversationHistory: Anthropic.MessageParam[]
	}> {
		const history = this.cacheService.getGlobalStateKey("taskHistory")
		const historyItem = history.find((item) => item.id === id)
		if (historyItem) {
			const taskDirPath = path.join(this.context.globalStorageUri.fsPath, "tasks", id)
			const apiConversationHistoryFilePath = path.join(taskDirPath, GlobalFileNames.apiConversationHistory)
			const uiMessagesFilePath = path.join(taskDirPath, GlobalFileNames.uiMessages)
			const contextHistoryFilePath = path.join(taskDirPath, GlobalFileNames.contextHistory)
			const taskMetadataFilePath = path.join(taskDirPath, GlobalFileNames.taskMetadata)
			const fileExists = await fileExistsAtPath(apiConversationHistoryFilePath)
			if (fileExists) {
				const apiConversationHistory = JSON.parse(await fs.readFile(apiConversationHistoryFilePath, "utf8"))
				return {
					historyItem,
					taskDirPath,
					apiConversationHistoryFilePath,
					uiMessagesFilePath,
					contextHistoryFilePath,
					taskMetadataFilePath,
					apiConversationHistory,
				}
			}
		}
		await this.deleteTaskFromState(id)
		throw new Error("Task not found")
	}

	async exportTaskWithId(id: string) {
		const { historyItem, apiConversationHistory } = await this.getTaskWithId(id)
		await downloadTask(historyItem.ts, apiConversationHistory)
	}

	async deleteTaskFromState(id: string) {
		const taskHistory = this.cacheService.getGlobalStateKey("taskHistory")
		const updatedTaskHistory = taskHistory.filter((task) => task.id !== id)
		this.cacheService.setGlobalState("taskHistory", updatedTaskHistory)
		await this.postStateToWebview()
		return updatedTaskHistory
	}

	async postStateToWebview() {
		const state = await this.getStateToPostToWebview()
		await sendStateUpdate(this.id, state)
	}

	async getStateToPostToWebview(): Promise<ExtensionState> {
		const apiConfiguration = this.cacheService.getApiConfiguration()
		const lastShownAnnouncementId = this.cacheService.getGlobalStateKey("lastShownAnnouncementId")
		const taskHistory = this.cacheService.getGlobalStateKey("taskHistory")
		const autoApprovalSettings = this.cacheService.getGlobalStateKey("autoApprovalSettings")
		const browserSettings = this.cacheService.getGlobalStateKey("browserSettings")
		const focusChainSettings = this.cacheService.getGlobalStateKey("focusChainSettings")
		const focusChainFeatureFlagEnabled = this.cacheService.getGlobalStateKey("focusChainFeatureFlagEnabled")
		const preferredLanguage = this.cacheService.getGlobalStateKey("preferredLanguage")
		const openaiReasoningEffort = this.cacheService.getGlobalStateKey("openaiReasoningEffort")
		const mode = this.cacheService.getGlobalStateKey("mode")
		const strictPlanModeEnabled = this.cacheService.getGlobalStateKey("strictPlanModeEnabled")
		const useAutoCondense = this.cacheService.getGlobalStateKey("useAutoCondense")
		const userInfo = this.cacheService.getGlobalStateKey("userInfo")
		const mcpMarketplaceEnabled = this.cacheService.getGlobalStateKey("mcpMarketplaceEnabled")
		const mcpDisplayMode = this.cacheService.getGlobalStateKey("mcpDisplayMode")
		const telemetrySetting = this.cacheService.getGlobalStateKey("telemetrySetting")
		const planActSeparateModelsSetting = this.cacheService.getGlobalStateKey("planActSeparateModelsSetting")
		const enableCheckpointsSetting = this.cacheService.getGlobalStateKey("enableCheckpointsSetting")
		const globalClineRulesToggles = this.cacheService.getGlobalStateKey("globalClineRulesToggles")
		const globalWorkflowToggles = this.cacheService.getGlobalStateKey("globalWorkflowToggles")
		const shellIntegrationTimeout = this.cacheService.getGlobalStateKey("shellIntegrationTimeout")
		const terminalReuseEnabled = this.cacheService.getGlobalStateKey("terminalReuseEnabled")
		const defaultTerminalProfile = this.cacheService.getGlobalStateKey("defaultTerminalProfile")
		const isNewUser = this.cacheService.getGlobalStateKey("isNewUser")
		const welcomeViewCompleted = Boolean(
			this.cacheService.getGlobalStateKey("welcomeViewCompleted") || this.authService.getInfo()?.user?.uid,
		)
		const customPrompt = this.cacheService.getGlobalStateKey("customPrompt")
		const mcpResponsesCollapsed = this.cacheService.getGlobalStateKey("mcpResponsesCollapsed")
		const terminalOutputLineLimit = this.cacheService.getGlobalStateKey("terminalOutputLineLimit")
		const localClineRulesToggles = this.cacheService.getWorkspaceStateKey("localClineRulesToggles")
		const localWindsurfRulesToggles = this.cacheService.getWorkspaceStateKey("localWindsurfRulesToggles")
		const localCursorRulesToggles = this.cacheService.getWorkspaceStateKey("localCursorRulesToggles")
		const workflowToggles = this.cacheService.getWorkspaceStateKey("workflowToggles")

		/* realtek ameba 相关状态 */
		const amebaSdkRoot = this.cacheService.getGlobalStateKey("amebaSdkRoot")
		const amebaSdkVersion = this.cacheService.getGlobalStateKey("amebaSdkVersion")
		const amebaIcSelection = this.cacheService.getGlobalStateKey("amebaIcSelection")
		const amebaSerialPorts = this.cacheService.getGlobalStateKey("amebaSerialPorts")
		const amebaSelectedSerialPort = this.cacheService.getGlobalStateKey("amebaSelectedSerialPort")
		const amebaToolChainEnv = this.cacheService.getGlobalStateKey("amebaToolChainEnv")
		const amebaIcVariants = this.cacheService.getGlobalStateKey("amebaIcVariants")

		// [修改] 获取多服务器配置
		const amebaRemoteServers = this.getAmebaRemoteServers()

		const currentTaskItem = this.task?.taskId ? (taskHistory || []).find((item) => item.id === this.task?.taskId) : undefined
		const checkpointTrackerErrorMessage = this.task?.taskState.checkpointTrackerErrorMessage
		const clineMessages = this.task?.messageStateHandler.getClineMessages() || []

		const processedTaskHistory = (taskHistory || [])
			.filter((item) => item.ts && item.task)
			.sort((a, b) => b.ts - a.ts)
			.slice(0, 100)

		const latestAnnouncementId = getLatestAnnouncementId(this.context)
		const shouldShowAnnouncement = lastShownAnnouncementId !== latestAnnouncementId
		const platform = process.platform as Platform
		const distinctId = PostHogClientProvider.getInstance().distinctId
		const version = this.context.extension?.packageJSON?.version ?? ""
		const uriScheme = vscode.env.uriScheme

		return {
			version,
			apiConfiguration,
			uriScheme,
			currentTaskItem,
			checkpointTrackerErrorMessage,
			clineMessages,
			currentFocusChainChecklist: this.task?.taskState.currentFocusChainChecklist || null,
			taskHistory: processedTaskHistory,
			shouldShowAnnouncement,
			platform,
			autoApprovalSettings,
			browserSettings,
			focusChainSettings,
			focusChainFeatureFlagEnabled,
			preferredLanguage,
			openaiReasoningEffort,
			mode,
			strictPlanModeEnabled,
			useAutoCondense,
			userInfo,
			mcpMarketplaceEnabled,
			mcpDisplayMode,
			telemetrySetting,
			planActSeparateModelsSetting,
			enableCheckpointsSetting: enableCheckpointsSetting ?? true,
			distinctId,
			globalClineRulesToggles: globalClineRulesToggles || {},
			localClineRulesToggles: localClineRulesToggles || {},
			localWindsurfRulesToggles: localWindsurfRulesToggles || {},
			localCursorRulesToggles: localCursorRulesToggles || {},
			localWorkflowToggles: workflowToggles || {},
			globalWorkflowToggles: globalWorkflowToggles || {},
			shellIntegrationTimeout,
			terminalReuseEnabled,
			defaultTerminalProfile,
			isNewUser,
			welcomeViewCompleted: welcomeViewCompleted as boolean,
			mcpResponsesCollapsed,
			terminalOutputLineLimit,
			customPrompt,
			/* realtek ameba add */
			amebaSdkRoot: amebaSdkRoot as string | undefined,
			amebaSdkVersion: amebaSdkVersion as string | undefined,
			amebaIcSelection: amebaIcSelection as string | undefined,
			amebaIcVariants: (amebaIcVariants as string[] | undefined) || [],
			amebaSerialPorts: (amebaSerialPorts as PortInfo[] | undefined) || [],
			amebaSelectedSerialPort: amebaSelectedSerialPort as string | undefined,
			amebaToolChainEnv: amebaToolChainEnv as string | undefined,
			amebaRemoteServers: amebaRemoteServers,
			/* realtek ameba end */
		}
	}

	async clearTask() {
		if (this.task) {
		}
		await this.task?.abortTask()
		this.task = undefined
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		const history = this.cacheService.getGlobalStateKey("taskHistory")
		const existingItemIndex = history.findIndex((h) => h.id === item.id)
		if (existingItemIndex !== -1) {
			history[existingItemIndex] = item
		} else {
			history.push(item)
		}
		this.cacheService.setGlobalState("taskHistory", history)
		return history
	}

	/* realtek ameba 相关方法（仅保留串口列表功能） */
	public async getAmebaSdkRoot(): Promise<string | undefined> {
		return this.cacheService.getGlobalStateKey("amebaSdkRoot")
	}

	public async getAmebaIcSelection(): Promise<string | undefined> {
		return this.cacheService.getGlobalStateKey("amebaIcSelection")
	}

	public async getSelectedAmebaSerialPort(): Promise<string | undefined> {
		return this.cacheService.getGlobalStateKey("amebaSelectedSerialPort")
	}

	public async setAmebaSdkRoot(sdkRoot: string | undefined): Promise<void> {
		const currentSdkRoot = await this.getAmebaSdkRoot()
		if (!sdkRoot) {
			console.log(`[Controller] Ameba SDK root undefine updated to: ${sdkRoot}`)
			HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message: "Ameba SDK Search Failed, please open Ameba SDK Folder.",
			})
		}

		if (sdkRoot !== currentSdkRoot) {
			this.cacheService.setGlobalState("amebaSdkRoot", sdkRoot)
			console.log(`[Controller] Ameba SDK root updated to: ${sdkRoot}`)

			if (sdkRoot) {
				HostProvider.window.showMessage({
					type: ShowMessageType.INFORMATION,
					message: `Ameba SDK path automatically set to: ${sdkRoot}`,
				})
			}
		}
	}

	public async setAmebaIcSelection(icSelection: string | undefined): Promise<void> {
		this.cacheService.setGlobalState("amebaIcSelection", icSelection)
		console.log(`[Controller] Ameba IC selection updated to: ${icSelection}`)
		await this.postStateToWebview()
	}

	private async setAmebaSdkVersion(version: string | undefined): Promise<void> {
		const currentVersion = this.cacheService.getGlobalStateKey("amebaSdkVersion")
		if (version !== currentVersion) {
			this.cacheService.setGlobalState("amebaSdkVersion", version)
			console.log(`[Controller] Ameba SDK Version updated to: ${version}`)
		}
	}

	// 存储IC变体列表并更新当前选择
	private async setAmebaIcVariants(variants: string[]): Promise<void> {
		this.cacheService.setGlobalState("amebaIcVariants", variants)
		console.log(`[Controller] Ameba IC variants updated to: [${variants.join(", ")}]`)

		// 检查当前选择的IC是否有效
		const currentSelection = await this.getAmebaIcSelection()
		const isSelectionValid = currentSelection ? variants.includes(currentSelection) : false

		// 如当前选择无效，设置新默认值
		if (!isSelectionValid) {
			const newSelection = variants.length > 0 ? variants[0] : undefined
			if (newSelection !== currentSelection) {
				await this.setAmebaIcSelection(newSelection)
			}
		}
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

	// 从SDK路径动态获取IC列表
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

	private async autoDetectAndSetAmebaSdkRoot(): Promise<void> {
		this.stopPrebuiltsReminder()
		this.stopVenvReminder()

		const response = await HostProvider.workspace.getWorkspacePaths({})
		const workspaceFolders = response.paths
		if (!workspaceFolders || workspaceFolders.length === 0) {
			console.log("[Ameba SDK] No workspace folder open. Skipping auto-detection.")
			await this.setAmebaSdkRoot(undefined)
			await this.setAmebaToolChainEnv(undefined)
			await this.setAmebaIcVariants([])
			await this.setAmebaSdkVersion(undefined)
			await this.postStateToWebview()
			return
		}

		const rootPath = workspaceFolders[0]
		const foundSdkPath = await this.findAmebaSdkRoot(rootPath)

		await this.setAmebaSdkRoot(foundSdkPath)

		if (foundSdkPath) {
			const version = await this.parseAmebaRtosVersion(foundSdkPath)
			const variants = await this.getAmebaIcVariantsFromSdk(foundSdkPath)
			await this.setAmebaSdkVersion(version)
			await this.setAmebaIcVariants(variants)
			await this.checkAndSetupAmebaToolChainEnv(foundSdkPath)
		} else {
			await this.setAmebaToolChainEnv(undefined)
			await this.setAmebaSdkVersion(undefined)
			await this.setAmebaIcVariants([])
			HostProvider.window.showMessage({
				type: ShowMessageType.WARNING,
				message: "Ameba SDK not found in the workspace. Please open an Ameba SDK project or set the path manually.",
			})
		}
		await this.postStateToWebview()
	}

	public async setAmebaToolChainEnv(envPath: string | undefined): Promise<void> {
		const currentPath = this.cacheService.getGlobalStateKey("amebaToolChainEnv")
		if (envPath !== currentPath) {
			this.cacheService.setGlobalState("amebaToolChainEnv", envPath)
			console.log(`[Controller] Ameba Toolchain Env Path updated to: ${envPath}`)
			if (envPath) {
				this.stopPrebuiltsReminder()
				this.stopVenvReminder()
			}
			await this.postStateToWebview()
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
			await this.setAmebaToolChainEnv(undefined)
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
				await this.setAmebaToolChainEnv(undefined)
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
					await this.setAmebaToolChainEnv(baseToolchainDir)
				}
			} else {
				console.log(`[Ameba Env] Toolchain Dir not found at: ${prebuiltsDir}.`)
				await this.setAmebaToolChainEnv(undefined)
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
			await this.setAmebaToolChainEnv(undefined)
		}
	}

	private stopPrebuiltsReminder(): void {
		if (this.prebuiltsReminderTimer) {
			clearTimeout(this.prebuiltsReminderTimer)
			this.prebuiltsReminderTimer = undefined
		}
		if (this.isPrebuiltsReminderActive) {
			this.isPrebuiltsReminderActive = false
			console.log("[Ameba Env] Prebuilts installation reminder loop stopped.")
		}
	}

	private stopVenvReminder(): void {
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
			await this.setAmebaToolChainEnv(baseToolchainDir)
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
				await this.setAmebaToolChainEnv(baseToolchainDir)
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
						const tempDir = await this.ensureCacheDirectoryExists()
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
						await this.setAmebaToolChainEnv(targetUnzipDir)
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
			await this.setAmebaToolChainEnv(undefined)
			if (!this.isPrebuiltsReminderActive) {
				this.isPrebuiltsReminderActive = true
				const version = path.basename(finalDirPath).split("-").pop() || ""
				this.promptAndRemindToInstallPrebuilts(version, targetUnzipDir, urls, finalDirPath, sdkRoot, platform)
			}
		}
	}

	/* --- [修改] 遠端伺服器管理 --- */
	private getAmebaRemoteServers(): AmebaRemoteServer[] {
		return this.cacheService.getGlobalStateKey("amebaRemoteServers") || []
	}

	private async saveAmebaRemoteServers(servers: AmebaRemoteServer[]): Promise<void> {
		this.cacheService.setGlobalState("amebaRemoteServers", servers)
		this.serialPortManager?.updateServerList(servers)
		await this.postStateToWebview()
	}

	public async amebaManageRemoteServers(): Promise<void> {
		const servers = this.getAmebaRemoteServers()

		const items: (vscode.QuickPickItem & { host?: string; action?: "add" | "delete" })[] = [
			{ label: "$(add) Add New Remote Server", description: "Configure a new server connection", action: "add" },
			...servers.map((s) => ({
				label: `$(server) ${s.name}`,
				description: `${s.host}:${s.port}`,
				detail: "Select to delete this server.",
				host: s.host,
				// highlight-start
				// 使用 as const 來告訴 TypeScript 這是字面量型別 "delete"
				action: "delete" as const,
				// highlight-end
			})),
		]

		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: "Select a server to delete, or add a new one",
		})

		if (!selection) {
			return
		}

		if (selection.action === "add") {
			await this.promptForNewServer()
		} else if (selection.action === "delete" && selection.host) {
			const serverToDelete = servers.find((s) => s.host === selection.host)
			if (serverToDelete) {
				const confirmResponse = await HostProvider.window.showMessage({
					type: ShowMessageType.WARNING,
					message: `Are you sure you want to delete the remote server "${serverToDelete.name}" (${serverToDelete.host})?`,
					options: {
						modal: true,
						items: ["Delete"],
					},
				})

				if (confirmResponse.selectedOption === "Delete") {
					const updatedServers = servers.filter((s) => s.host !== selection.host)
					await this.saveAmebaRemoteServers(updatedServers)
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: `Remote server "${serverToDelete.name}" deleted.`,
					})
				}
			}
		}
	}

	private async promptForNewServer(): Promise<void> {
		const currentServers = this.getAmebaRemoteServers()

		const nameResult = await HostProvider.window.showInputBox({
			title: "Server Name",
			prompt: "Enter a name for the new remote server",
		})

		// 正確的檢查方式：檢查物件內的 response 屬性是否為空
		const name = nameResult.response?.trim()
		if (!name) {
			return // 如果使用者取消或輸入為空，則退出
		}

		const hostResult = await HostProvider.window.showInputBox({
			title: "Server IP",
			prompt: "Enter the server's IP address or hostname",
		})

		const host = hostResult.response?.trim()
		if (!host) {
			return
		}

		const portResult = await HostProvider.window.showInputBox({
			title: "Server Port",
			prompt: "Enter the server's port number",
			value: "58916",
		})

		const portStr = portResult.response?.trim()
		if (!portStr) {
			return
		}

		const port = Number(portStr)
		if (Number.isNaN(port) || port <= 0 || port >= 65536) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Please enter a valid port number (1-65535).",
			})
			return
		}

		const newServer: AmebaRemoteServer = { name, host, port }
		await this.saveAmebaRemoteServers([...currentServers, newServer])
		HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: `Remote server "${name}" added.` })
	}
	/* --- [修改結束] --- */

	/* 串口列表相关方法 */
	public async forceRefreshSerialPorts(): Promise<void> {
		if (this.serialPortManager) {
			await this.serialPortManager.forceCheckForPortChanges()
		}
	}

	private async handleSerialPortsChange(ports: PortInfo[], isFirst: boolean): Promise<void> {
		console.log(`[Controller] Handling serial port changes. Total: ${ports.length}. Is first: ${isFirst}.`)

		this.cacheService.setGlobalState("amebaSerialPorts", ports)

		const currentSelection = this.cacheService.getGlobalStateKey("amebaSelectedSerialPort")
		const isCurrentSelectionValid = currentSelection ? ports.some((p) => p.path === currentSelection) : false

		if (!isCurrentSelectionValid) {
			const newSelection = ports.length > 0 ? ports[0].path : undefined
			if (newSelection !== currentSelection) {
				await this.setSelectedAmebaSerialPort(newSelection)
			} else {
				// 即使選擇沒變，也可能需要更新 UI（例如列表為空）
				await this.postStateToWebview()
			}
		} else {
			await this.postStateToWebview()
		}
	}

	private startPeriodicPortRefresh(intervalMs: number = 3000): void {
		if (this.portRefreshInterval) {
			clearInterval(this.portRefreshInterval)
		}

		this.portRefreshInterval = setInterval(() => {
			console.log("[Controller] Periodically refreshing serial ports...")
			this.forceRefreshSerialPorts().catch((err) => console.error("[Controller] Failed to refresh ports:", err))
		}, intervalMs)

		console.log(`[Controller] Started periodic port refresh every ${intervalMs / 1000} seconds`)
	}

	public async setSelectedAmebaSerialPort(portPath: string | undefined): Promise<void> {
		this.cacheService.setGlobalState("amebaSelectedSerialPort", portPath)
		console.log(`[Controller] Ameba serial port selection updated to: ${portPath}`)
		await this.postStateToWebview()
	}
	/* realtek ameba add end*/
}
