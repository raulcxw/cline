import { Empty, StringRequest } from "@shared/proto/cline/common"
import { HostProvider } from "@/hosts/host-provider"
import { ShowMessageType } from "@/shared/proto/host/window"
import { openExternal } from "@/utils/env"
import type { Controller } from "../index"

export async function amebaOpenDocUrl(controller: Controller, request: StringRequest): Promise<Empty> {
	const url = request.value

	if (url) {
		try {
			// 使用 VS Code API 在預設瀏覽器中開啟連結
			await openExternal(url)
		} catch (e) {
			const error = e instanceof Error ? e : new Error(String(e))
			console.error(`Failed to open external link: ${url}`, error)
			HostProvider.window.showMessage({
				type: ShowMessageType.ERROR,
				message: "Could not open link: ${url}",
			})
		}
	}
	return Empty.create({})
}
