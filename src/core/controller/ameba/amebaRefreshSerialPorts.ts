import { Empty, EmptyRequest } from "@shared/proto/cline/common"
import type { Controller } from "../index"

export async function amebaRefreshSerialPorts(controller: Controller, request: EmptyRequest): Promise<Empty> {
	// 修改点：调用 Controller 中的新方法来强制执行一次串口扫描
	await controller.forceRefreshSerialPorts()
	return Empty.create({})
}
