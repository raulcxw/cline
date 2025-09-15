import { Empty, StringRequest } from "@shared/proto/cline/common"
import type { Controller } from "../index"

export async function amebaUpdateExample(controller: Controller, request: StringRequest): Promise<Empty> {
	const example = request.value

	// 增加一个检查，确保传入的值不为空字符串
	if (example) {
		console.log(`[gRPC][Ameba] Updating Example to: ${example}`)

		// 修正：使用单个 await
		await controller.setSelectedAmebaExample(example)
	} else {
		// 可以考虑增加一个日志，用于调试空值传入的情况
		console.warn("[gRPC][Ameba] Received an empty Example value. No update will be performed.")
	}
	return Empty.create({})
}
