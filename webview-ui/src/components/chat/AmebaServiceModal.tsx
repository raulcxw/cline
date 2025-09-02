import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
// [修改] 引入 useMemo
import React, { useMemo } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AmebaServiceClient } from "@/services/grpc-client"
import Tooltip from "../common/Tooltip"

// --- Styled Components (保持不變) ---
const StyledLinkDropdown = styled(VSCodeDropdown)`
	&::part(indicator) {
		display: none;
	}
	&::part(control) {
		background: transparent;
		border: none;
		color: var(--vscode-descriptionForeground);
		font-size: 12px;
		text-align: center;
		padding: 2px 4px;
		transition: all 0.2s ease;
	}
	&:hover:not([disabled])::part(control) {
		background: transparent;
		color: var(--vscode-foreground);
		text-decoration: underline;
		cursor: pointer;
	}
	&[disabled]::part(control) {
		cursor: not-allowed;
		opacity: 0.6;
	}
	&::part(listbox) {
		z-index: 9999;
		background: var(--vscode-dropdown-background);
		border: 1px solid var(--vscode-dropdown-border);
	}
`

const StyledOption = styled(VSCodeOption)`
	&::part(content) {
		background: transparent;
		color: var(--vscode-foreground);
		font-size: 12px;
	}
	&:hover::part(content) {
		background: var(--vscode-list-hoverBackground);
	}
	&[selected]::part(content) {
		background: var(--vscode-list-activeSelectionBackground);
		color: var(--vscode-list-activeSelectionForeground);
	}
`

const ControlsRow = styled.div`
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 15px 8px 15px;
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
`
// --- Styled Components End ---

const AmebaServiceModal: React.FC = () => {
	const { amebaSdkRoot, amebaToolChainEnv, amebaIcSelection, amebaIcVariants, amebaSerialPorts, amebaSelectedSerialPort } =
		useExtensionState()

	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)

	// --- [新增] 使用 useMemo 計算下拉選單的動態寬度 ---
	const icDropdownMinWidth = useMemo(() => {
		const baseMinWidth = 75 // 設定一個基礎最小寬度
		if (!amebaIcVariants || amebaIcVariants.length === 0) {
			return `${baseMinWidth}px`
		}

		// 使用 Canvas API 來精確測量文字寬度，這比單純計算字元數更準確
		const canvas = document.createElement("canvas")
		const context = canvas.getContext("2d")

		if (context) {
			// 設定與 CSS 匹配的字體大小和樣式
			context.font = "12px var(--vscode-font-family, sans-serif)"

			// 找出最長的 variant 渲染後所需的寬度
			const maxWidth = amebaIcVariants.reduce((max, variant) => {
				const width = context.measureText(variant).width
				return Math.max(max, width)
			}, 0)

			// 加上一些內邊距 (padding) 和緩衝空間
			const totalWidth = Math.ceil(maxWidth) + 20 // 24px 作為左右邊距和緩衝

			// 返回計算後的寬度，但不小於基礎寬度
			return `${Math.max(baseMinWidth, totalWidth)}px`
		}

		// 如果 Canvas 無法使用，則退回基礎寬度
		return `${baseMinWidth}px`
	}, [amebaIcVariants]) // 僅在 amebaIcVariants 陣列變化時重新計算

	// --- Event Handlers (保持不變) ---
	const handleMenuConfigClick = async () => {
		try {
			await AmebaServiceClient.amebaMenuConfig(EmptyRequest.create())
		} catch (error) {
			console.error("Failed to execute Ameba MenuConfig:", error)
		}
	}

	const handleBuildClick = async () => {
		try {
			await AmebaServiceClient.amebaBuild(EmptyRequest.create())
		} catch (error) {
			console.error("Failed to execute Ameba Build:", error)
		}
	}

	const handleFlashClick = async () => {
		try {
			await AmebaServiceClient.amebaFlash(EmptyRequest.create())
		} catch (error) {
			console.error("Failed to execute Ameba Flash:", error)
		}
	}

	const handleMonitorClick = async () => {
		try {
			await AmebaServiceClient.amebaMonitor(EmptyRequest.create())
		} catch (error) {
			console.error("Failed to execute Ameba Monitor:", error)
		}
	}

	const handleIcSelectionChange = async (e: any) => {
		const newIc = e.target.value
		if (newIc && newIc !== amebaIcSelection) {
			try {
				await AmebaServiceClient.amebaUpdateChipSelection(StringRequest.create({ value: newIc }))
			} catch (error) {
				console.error("Failed to update Ameba Chip selection:", error)
			}
		}
	}

	const handlePortSelectionChange = async (e: any) => {
		const selectedValue = e.target.value
		if (selectedValue !== amebaSelectedSerialPort) {
			try {
				await AmebaServiceClient.amebaUpdateSerialPort(StringRequest.create({ value: selectedValue }))
			} catch (error) {
				console.error("Failed to update Ameba Serial Port:", error)
			}
		}
	}
	// --- Event Handlers End ---

	const portDropdownKey = amebaSerialPorts.length

	// --- 工具函数（保持不变）---
	const getDisabledTooltipText = (): string => {
		const sdkError = "Ameba SDK not found. Please open an SDK project folder or set the path manually."
		const toolchainError = "Ameba Toolchain directory and Prebuilts check failed. Please verify the installation."

		const errors: string[] = []
		if (!amebaSdkRoot) {
			errors.push(sdkError)
		} else if (!amebaToolChainEnv) {
			errors.push(toolchainError)
		}

		if (errors.length === 0) {
			return "Ameba SDK environment is ready."
		}

		return errors.join("\n")
	}

	const disabledTooltipText = getDisabledTooltipText()

	const getChipTooltipText = (): string => {
		if (isAmebaSdkReady) {
			const sdkVersion = "v1.1"
			const details = [`SDK Path: ${amebaSdkRoot}`, `Toolchain Path: ${amebaToolChainEnv}`, `SDK Ver: ${sdkVersion}`]
			return details.join("\n")
		}
		return disabledTooltipText
	}

	const chipTooltipText = getChipTooltipText()

	const chipTooltipStyle: React.CSSProperties = {
		left: "0px",
		zIndex: 1001,
	}

	const dropdownTooltipStyle: React.CSSProperties = {
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: 1001,
		whiteSpace: "nowrap",
	}

	// --- 渲染部分 ---
	return (
		<ControlsRow>
			<Tooltip style={chipTooltipStyle} tipText={chipTooltipText}>
				<span
					className="codicon codicon-chip"
					style={{
						fontSize: "16px",
						verticalAlign: "middle",
						cursor: "default",
						color: isAmebaSdkReady ? "var(--vscode-textLink-foreground)" : "var(--vscode-disabledForeground)",
					}}></span>
			</Tooltip>

			<Tooltip style={dropdownTooltipStyle} tipText={isAmebaSdkReady ? "Select Chip" : disabledTooltipText}>
				{/* --- [修改] 將計算出的 minWidth 應用到 style --- */}
				<StyledLinkDropdown
					disabled={!isAmebaSdkReady}
					onChange={handleIcSelectionChange}
					style={{ minWidth: icDropdownMinWidth }}
					value={amebaIcSelection || ""}>
					{(amebaIcVariants || []).map((variant) => (
						<StyledOption key={variant} value={variant}>
							{variant}
						</StyledOption>
					))}
				</StyledLinkDropdown>
			</Tooltip>

			<Tooltip style={dropdownTooltipStyle} tipText={isAmebaSdkReady ? "Select Serial Port" : disabledTooltipText}>
				<StyledLinkDropdown
					disabled={!isAmebaSdkReady}
					key={portDropdownKey}
					onChange={amebaSerialPorts.length > 0 ? handlePortSelectionChange : undefined}
					style={{ minWidth: "45px" }}
					value={amebaSelectedSerialPort || ""}>
					{amebaSerialPorts.length === 0 ? (
						<StyledOption disabled value="no-port-placeholder">
							No port found
						</StyledOption>
					) : (
						amebaSerialPorts.map((port) => (
							<StyledOption key={port.path} value={port.path}>
								{port.path}
							</StyledOption>
						))
					)}
				</StyledLinkDropdown>
			</Tooltip>

			{/* 其他按鈕保持不變 */}
			<Tooltip tipText={isAmebaSdkReady ? "Ameba Menuconfig" : disabledTooltipText}>
				<VSCodeButton
					appearance="icon"
					aria-label="Ameba Menuconfig"
					disabled={!isAmebaSdkReady}
					onClick={handleMenuConfigClick}>
					<span className="codicon codicon-checklist" />
				</VSCodeButton>
			</Tooltip>

			<Tooltip tipText={isAmebaSdkReady ? "Ameba Build" : disabledTooltipText}>
				<VSCodeButton appearance="icon" aria-label="Ameba Build" disabled={!isAmebaSdkReady} onClick={handleBuildClick}>
					<span className="codicon codicon-tools" />
				</VSCodeButton>
			</Tooltip>

			<Tooltip tipText={isAmebaSdkReady ? "Ameba Flash" : disabledTooltipText}>
				<VSCodeButton appearance="icon" aria-label="Ameba Flash" disabled={!isAmebaSdkReady} onClick={handleFlashClick}>
					<span className="codicon codicon-symbol-event" />
				</VSCodeButton>
			</Tooltip>

			<Tooltip tipText={isAmebaSdkReady ? "Ameba Monitor" : disabledTooltipText}>
				<VSCodeButton
					appearance="icon"
					aria-label="Ameba Monitor"
					disabled={!isAmebaSdkReady}
					onClick={handleMonitorClick}>
					<span className="codicon codicon-vm" />
				</VSCodeButton>
			</Tooltip>
		</ControlsRow>
	)
}

export default AmebaServiceModal
