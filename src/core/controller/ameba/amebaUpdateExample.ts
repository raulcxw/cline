import { Empty, StringRequest } from "@shared/proto/cline/common"
import type { Controller } from "../index"

export async function amebaUpdateExample(controller: Controller, request: StringRequest): Promise<Empty> {
	const example = request.value

	console.log(`[gRPC][Ameba] Updating Example to: ${example}`)

	await controller.setSelectedAmebaExample(example)

	return Empty.create({})
}
