import * as process from "process"
import * as vscode from "vscode"
import { Controller } from "@/core/controller"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"

export interface TerminalInfo {
	terminal: vscode.Terminal
	busy: boolean
	lastCommand: string
	id: number
	shellPath?: string
	lastActive: number
	pendingCwdChange?: string
	cwdResolved?: {
		resolve: () => void
		reject: (error: Error) => void
	}
}

// Although vscode.window.terminals provides a list of all open terminals, there's no way to know whether they're busy or not (exitStatus does not provide useful information for most commands). In order to prevent creating too many terminals, we need to keep track of terminals through the life of the extension, as well as session specific terminals for the life of a task (to get latest unretrieved output).
// Since we have promises keeping track of terminal processes, we get the added benefit of keep track of busy terminals even after a task is closed.
export class TerminalRegistry {
	private static terminals: TerminalInfo[] = []
	private static nextTerminalId = 1

	/* realtek ameba add start*/
	private static amebaTerminalInfo: TerminalInfo | null = null
	/* realtek ameba add end*/

	static createTerminal(cwd?: string | vscode.Uri | undefined, shellPath?: string): TerminalInfo {
		const terminalOptions: vscode.TerminalOptions = {
			cwd,
			name: "Cline",
			iconPath: new vscode.ThemeIcon("robot"),
			env: {
				CLINE_ACTIVE: "true",
			},
		}

		// If a specific shell path is provided, use it
		if (shellPath) {
			terminalOptions.shellPath = shellPath
		}

		const terminal = vscode.window.createTerminal(terminalOptions)
		TerminalRegistry.nextTerminalId++
		const newInfo: TerminalInfo = {
			terminal,
			busy: false,
			lastCommand: "",
			id: TerminalRegistry.nextTerminalId,
			shellPath,
			lastActive: Date.now(),
		}
		TerminalRegistry.terminals.push(newInfo)
		return newInfo
	}

	static getTerminal(id: number): TerminalInfo | undefined {
		const terminalInfo = TerminalRegistry.terminals.find((t) => t.id === id)
		if (terminalInfo && TerminalRegistry.isTerminalClosed(terminalInfo.terminal)) {
			TerminalRegistry.removeTerminal(id)
			return undefined
		}
		return terminalInfo
	}

	static updateTerminal(id: number, updates: Partial<TerminalInfo>) {
		const terminal = TerminalRegistry.getTerminal(id)
		if (terminal) {
			Object.assign(terminal, updates)
		}
	}

	static removeTerminal(id: number) {
		TerminalRegistry.terminals = TerminalRegistry.terminals.filter((t) => t.id !== id)
	}

	static getAllTerminals(): TerminalInfo[] {
		TerminalRegistry.terminals = TerminalRegistry.terminals.filter((t) => !TerminalRegistry.isTerminalClosed(t.terminal))
		return TerminalRegistry.terminals
	}

	// The exit status of the terminal will be undefined while the terminal is active. (This value is set when onDidCloseTerminal is fired.)
	private static isTerminalClosed(terminal: vscode.Terminal): boolean {
		return terminal.exitStatus !== undefined
	}

	/* realtek ameba add start*/
	/**
	 * [新增] 查找一个活动的 "Ameba" 终端，如果不存在则创建一个。
	 * 这个方法是独立的，不会将创建的终端添加到 this.terminals 列表中。
	 * @param cwd - The desired working directory.
	 * @param shellPath - Optional shell path.
	 * @returns The TerminalInfo for the Ameba terminal.
	 */
	static findOrCreateAmebaTerminal(cwd?: string | vscode.Uri | undefined, shellPath?: string): TerminalInfo {
		// 检查我们自己管理的 Ameba 终端是否存在且未关闭
		if (
			TerminalRegistry.amebaTerminalInfo &&
			!TerminalRegistry.isTerminalClosed(TerminalRegistry.amebaTerminalInfo.terminal)
		) {
			console.log("Reusing tracked Ameba terminal.")
			const trackedTerminal = TerminalRegistry.amebaTerminalInfo.terminal
			trackedTerminal.sendText(String.fromCharCode(3), false)
			TerminalRegistry.amebaTerminalInfo.terminal.show()
			return TerminalRegistry.amebaTerminalInfo
		}

		// 如果不存在或已关闭，则在 VS Code 的活动终端中查找
		const existingVscodeTerminal = vscode.window.terminals.find((t) => t.name === "Ameba")

		let terminal: vscode.Terminal
		if (existingVscodeTerminal) {
			console.log("Found existing Ameba terminal in VS Code list. Re-attaching.")
			terminal = existingVscodeTerminal
			terminal.sendText(String.fromCharCode(3), false)
		} else {
			console.log("No active Ameba terminal found. Creating a new one.")

			// --- 这是修改的核心部分 ---
			let effectiveShellPath = shellPath // 默认使用传入的 shellPath

			// 检查：1. 是否为 Windows 平台  2. shellPath 是否未被提供 (undefined, null, or '')
			if (process.platform === "win32" && !shellPath) {
				console.log("Windows platform detected and no shellPath provided. Forcing cmd.exe for compatibility.")
				// 使用环境变量 %ComSpec% 来找到 cmd.exe 的准确路径，这是最稳妥的方式
				effectiveShellPath = process.env.ComSpec || "cmd.exe"
			}
			// --- 修改结束 ---

			const terminalOptions: vscode.TerminalOptions = {
				cwd,
				name: "Ameba", // 使用固定的名字
				iconPath: new vscode.ThemeIcon("chip"),
				shellPath: effectiveShellPath, // 使用我们处理过的 shellPath
			}
			terminal = vscode.window.createTerminal(terminalOptions)
		}

		terminal.show() // 确保终端可见

		// 创建新的 TerminalInfo 并存储在专用的静态属性中
		const newInfo: TerminalInfo = {
			terminal,
			busy: false,
			lastCommand: "",
			id: TerminalRegistry.nextTerminalId++, // ID 仍然递增以保证唯一性
			// 注意：这里存储的是原始传入的 shellPath，而不是可能被覆盖的 effectiveShellPath
			// 这有助于我们了解调用者的原始意图。如果需要存储最终使用的 shell，可以改为 effectiveShellPath。
			shellPath,
			lastActive: Date.now(),
		}

		TerminalRegistry.amebaTerminalInfo = newInfo
		return newInfo
	}
	/* realtek ameba add end*/
}
