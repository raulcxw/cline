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
import fs from "fs/promises"
import pWaitFor from "p-wait-for"
import * as path from "path"
import * as vscode from "vscode"
import { clineEnvConfig } from "@/config"
import { HostProvider } from "@/hosts/host-provider"
import { AuthService } from "@/services/auth/AuthService"
import { PostHogClientProvider, telemetryService } from "@/services/posthog/PostHogClientProvider"
/* realtek ameba add start*/
import { AmebaExample, AmebaPortInfo, AmebaRemoteServer } from "@/shared/amebaInfo"
import { getLatestAnnouncementId } from "@/utils/announcements"
import { getCwd, getDesktopDir } from "@/utils/path"
import { CacheService, PersistenceErrorEvent } from "../storage/CacheService"
import { ensureMcpServersDirectoryExists, ensureSettingsDirectoryExists, GlobalFileNames } from "../storage/disk"
import { Task } from "../task"
import { AmebaEnvManager } from "./ameba/amebaEnvManager"
import { AmebaRemoteServerManager } from "./ameba/amebaRemoteServerManager"
import { AmebaSerialPort } from "./ameba/amebaSerialPort"
import { sendMcpMarketplaceCatalogEvent } from "./mcp/subscribeToMcpMarketplaceCatalog"
import { sendStateUpdate } from "./state/subscribeToState"
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
	public amebaEnvManager: AmebaEnvManager
	private amebaRemoteServerManager: AmebaRemoteServerManager
	private serialPortManager: AmebaSerialPort | undefined
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
		this.amebaEnvManager = new AmebaEnvManager(this)
		this.amebaRemoteServerManager = new AmebaRemoteServerManager(this)
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
				this.amebaEnvManager.runDetectionAndSetup()

				// 2. 监听工作区变化
				this.disposables.push(
					vscode.workspace.onDidChangeWorkspaceFolders(() => this.amebaEnvManager.runDetectionAndSetup()),
				)

				// 3. 启动定期刷新机制
				this.startPeriodicPortRefresh(2000)
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
		this.amebaEnvManager.dispose()
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

	public async ensureCacheDirectoryExists(): Promise<string> {
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
		const amebaExamples = this.cacheService.getGlobalStateKey("amebaExamples")
		const amebaSelectedExample = this.cacheService.getGlobalStateKey("amebaSelectedExample")
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
			amebaSerialPorts: (amebaSerialPorts as AmebaPortInfo[] | undefined) || [],
			amebaSelectedSerialPort: amebaSelectedSerialPort as AmebaPortInfo | undefined,
			amebaToolChainEnv: amebaToolChainEnv as string | undefined,
			amebaRemoteServers: (amebaRemoteServers as AmebaRemoteServer[]) || [],
			amebaExamples: (amebaExamples as AmebaExample[] | undefined) || [],
			amebaSelectedExample: amebaSelectedExample as AmebaExample | undefined,
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

	public async getSelectedAmebaSerialPort(): Promise<AmebaPortInfo | undefined> {
		return this.cacheService.getGlobalStateKey("amebaSelectedSerialPort")
	}

	public async getSelectedAmebaExample(): Promise<AmebaExample | undefined> {
		return this.cacheService.getGlobalStateKey("amebaSelectedExample")
	}

	public async setAmebaSdkRoot(sdkRoot: string | undefined): Promise<void> {
		const currentSdkRoot = await this.getAmebaSdkRoot()
		if (!sdkRoot) {
			console.log(`[Controller] Ameba SDK root undefine updated to: ${sdkRoot}`)
			//HostProvider.window.showMessage({
			//	type: ShowMessageType.WARNING,
			//	message: "Ameba SDK Search Failed, please open Ameba SDK Folder.",
			//})
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

	public async setAmebaExamples(examples: AmebaExample[]): Promise<void> {
		this.cacheService.setGlobalState("amebaExamples", examples)
		console.log(`[Controller] Ameba examples updated with ${examples.length} items.`)
	}

	public async setAmebaIcSelection(icSelection: string | undefined): Promise<void> {
		this.cacheService.setGlobalState("amebaIcSelection", icSelection)
		console.log(`[Controller] Ameba IC selection updated to: ${icSelection}`)
		await this.postStateToWebview()
	}

	public async setAmebaSdkVersion(version: string | undefined): Promise<void> {
		const currentVersion = this.cacheService.getGlobalStateKey("amebaSdkVersion")
		if (version !== currentVersion) {
			this.cacheService.setGlobalState("amebaSdkVersion", version)
			console.log(`[Controller] Ameba SDK Version updated to: ${version}`)
		}
	}

	// 存储IC变体列表并更新当前选择
	public async setAmebaIcVariants(variants: string[]): Promise<void> {
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

	public async setAmebaToolChainEnv(envPath: string | undefined): Promise<void> {
		const currentPath = this.cacheService.getGlobalStateKey("amebaToolChainEnv")
		if (envPath !== currentPath) {
			this.cacheService.setGlobalState("amebaToolChainEnv", envPath)
			console.log(`[Controller] Ameba Toolchain Env Path updated to: ${envPath}`)
			if (envPath) {
				this.amebaEnvManager.stopPrebuiltsReminder()
				this.amebaEnvManager.stopVenvReminder()
			}
			await this.postStateToWebview()
		}
	}

	/* --- [修改] 遠端伺服器管理 --- */
	public getAmebaRemoteServers(): AmebaRemoteServer[] {
		return this.cacheService.getGlobalStateKey("amebaRemoteServers") || []
	}

	public async saveAmebaRemoteServers(servers: AmebaRemoteServer[]): Promise<void> {
		this.cacheService.setGlobalState("amebaRemoteServers", servers)
		this.serialPortManager?.updateServerList(servers)
		await this.postStateToWebview()
	}

	public async amebaConfigRemoteServers(): Promise<void> {
		await this.amebaRemoteServerManager.configRemoteServers()
	}

	/* 串口列表相关方法 */
	public async forceRefreshSerialPorts(): Promise<void> {
		if (this.serialPortManager) {
			await this.serialPortManager.forceCheckForPortChanges()
		}
	}

	private async handleSerialPortsChange(ports: AmebaPortInfo[], isFirst: boolean): Promise<void> {
		console.log(`[Controller] Handling serial port changes. Total: ${ports.length}. Is first: ${isFirst}.`)

		this.cacheService.setGlobalState("amebaSerialPorts", ports)

		const currentSelection: AmebaPortInfo | undefined = this.cacheService.getGlobalStateKey("amebaSelectedSerialPort")
		const isCurrentSelectionValid = currentSelection ? ports.some((p) => p.path === currentSelection.path) : false

		if (!isCurrentSelectionValid) {
			const newSelectionPath = ports.length > 0 ? ports[0].path : undefined
			if (newSelectionPath !== currentSelection?.path) {
				await this.setSelectedAmebaSerialPort(newSelectionPath)
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
			console.log("[Controller] Periodically refreshing serial ports")
			this.forceRefreshSerialPorts().catch((err) => console.error("[Controller] Failed to refresh ports:", err))
		}, intervalMs)

		console.log(`[Controller] Started periodic port refresh every ${intervalMs / 1000} seconds`)
	}

	public async setSelectedAmebaSerialPort(portPath: string | undefined): Promise<void> {
		const allPorts = this.cacheService.getGlobalStateKey("amebaSerialPorts") || []

		// 根據傳入的 path 字串尋找完整的 PortInfo 物件
		const selectedPortInfo = portPath ? allPorts.find((p) => p.path === portPath) : undefined

		// 將找到的物件或 undefined 儲存到狀態中
		this.cacheService.setGlobalState("amebaSelectedSerialPort", selectedPortInfo)

		console.log(`[Controller] Ameba serial port selection updated to:`, selectedPortInfo)
		await this.postStateToWebview()
	}

	public async setSelectedAmebaExample(portPath: string | undefined): Promise<void> {
		const allPorts = this.cacheService.getGlobalStateKey("amebaExamples") || []

		// 根據傳入的 path 字串尋找完整的 PortInfo 物件
		const selectedExample = portPath ? allPorts.find((p) => p.path === portPath) : undefined

		// 將找到的物件或 undefined 儲存到狀態中
		this.cacheService.setGlobalState("amebaSelectedExample", selectedExample)

		console.log(`[Controller] Ameba Example selection updated to: `, selectedExample)
		await this.postStateToWebview()
	}
	/* realtek ameba add end*/
}
