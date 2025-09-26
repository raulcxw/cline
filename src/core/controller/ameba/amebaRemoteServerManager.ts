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
				description: s.pw ? `IP: ${s.host} Password: ${s.pw}` : `IP: ${s.host}`,
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

		if (currentServers.some((server) => server.name === name)) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `A server with the name "${name}" already exists. Please use a different name.`,
			})
			return
		}

		const hostResult = await HostProvider.window.showInputBox({
			title: "Server IP",
			prompt: "Enter the server's IP address",
		})

		const host = hostResult.response?.trim()
		if (!host) {
			return
		}

		if (currentServers.some((server) => server.host === host)) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: `A server with the IP address "${host}" already exists.`,
			})
			return
		}

		const ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/
		if (!ipv4Regex.test(host)) {
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Please enter a valid IPv4 address (e.g., 192.168.1.1).",
			})
			return
		}

		const pwResult = await HostProvider.window.showInputBox({
			title: "Password",
			prompt: "Enter the server's password",
		})

		const pw = pwResult.response?.trim()
		if (!pw) {
			return
		}

		console.log(`Remote server pw ${pwResult.response}`)

		const port = 58916

		const newServer: AmebaRemoteServer = { name, host, pw, port }
		await this.controller.saveAmebaRemoteServers([...currentServers, newServer])
		HostProvider.window.showMessage({ type: ShowMessageType.INFORMATION, message: `Remote server "${name}" added.` })
	}
}
