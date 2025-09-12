import { ShowMessageType } from "@shared/proto/host/window"
import * as vscode from "vscode"
import { Controller } from "@/core/controller"
import { HostProvider } from "@/hosts/host-provider"
import { AmebaRemoteServer } from "@/shared/amebaInfo"

export class AmebaRemoteServerManager {
	private controller: Controller

	constructor(controller: Controller) {
		this.controller = controller
	}

	public async configRemoteServers(): Promise<void> {
		const servers = this.controller.getAmebaRemoteServers()

		const items: (vscode.QuickPickItem & { host?: string; action?: "add" | "delete" })[] = [
			{ label: "$(add) Add New Remote Server", description: "Configure a new server connection", action: "add" },
			...servers.map((s) => ({
				label: `$(server) ${s.name}`,
				description: `${s.host}:${s.port}`,
				detail: "Select to delete this server.",
				host: s.host,
				action: "delete" as const,
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
					await this.controller.saveAmebaRemoteServers(updatedServers)
					HostProvider.window.showMessage({
						type: ShowMessageType.INFORMATION,
						message: `Remote server "${serverToDelete.name}" deleted.`,
					})
				}
			}
		}
	}

	private async promptForNewServer(): Promise<void> {
		const currentServers = this.controller.getAmebaRemoteServers()

		const nameResult = await HostProvider.window.showInputBox({
			title: "Server Name",
			prompt: "Enter a name for the new remote server",
		})

		const name = nameResult.response?.trim()
		if (!name) {
			return
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
		await this.controller.saveAmebaRemoteServers([...currentServers, newServer])
		HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: `Remote server "${name}" added.` })
	}
}
