import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import React, { useMemo, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AmebaServiceClient } from "@/services/grpc-client"
import Tooltip from "../common/Tooltip"

// --- Styled Components ---
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
const calculateTextWidth = (text: string | null | undefined, font: string): string => {
	const baseMinWidth = 45
	const padding = 15

	if (!text) {
		return `${baseMinWidth}px`
	}

	try {
		const canvas = document.createElement("canvas")
		const context = canvas.getContext("2d")
		if (context) {
			context.font = font
			const width = context.measureText(text).width
			return `${Math.max(baseMinWidth, Math.ceil(width) + padding)}px`
		}
	} catch (e) {
		console.error("Canvas context not available for width calculation.", e)
	}

	return `${Math.max(baseMinWidth, text.length * 8 + padding)}px`
}

const AmebaServiceModal: React.FC = () => {
	const {
		amebaSdkRoot,
		amebaSdkVersion,
		amebaToolChainEnv,
		amebaIcSelection,
		amebaIcVariants,
		amebaSerialPorts,
		amebaSelectedSerialPort,
	} = useExtensionState()

	const [isIcDropdownOpen, setIsIcDropdownOpen] = useState(false)
	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)

	const FONT_STYLE = "12px var(--vscode-font-family, sans-serif)"

	const longestIcWidth = useMemo(() => {
		if (!amebaIcVariants || amebaIcVariants.length === 0) {
			return "75px"
		}
		const longestVariant = amebaIcVariants.reduce((a, b) => (a.length > b.length ? a : b), "")
		return calculateTextWidth(longestVariant, FONT_STYLE)
	}, [amebaIcVariants])

	const selectedIcWidth = useMemo(() => {
		return calculateTextWidth(amebaIcSelection, FONT_STYLE)
	}, [amebaIcSelection])

	const icDropdownWidth = isIcDropdownOpen ? longestIcWidth : selectedIcWidth

	// --- [修改] 事件處理函式名稱，使其更語意化 ---
	const handleIcDropdownToggle = () => {
		// 使用函數式更新，根據當前狀態進行切換
		setIsIcDropdownOpen((current) => !current)
	}

	const handleIcDropdownClose = () => {
		// 這個函式仍然需要，用於「強制關閉」的場景（如 onBlur 或選擇選項）
		setIsIcDropdownOpen(false)
	}

	// --- Event Handlers (部分修改) ---
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

	const handleOpenDocsClick = async () => {
		try {
			const docsUrl = "https://aiot.realmcu.com/"
			await AmebaServiceClient.amebaOpenDocUrl(StringRequest.create({ value: docsUrl }))
		} catch (error) {
			console.error("Failed to open documentation link:", error)
		}
	}

	const handleIcSelectionChange = async (e: any) => {
		//handleIcDropdownClose()
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

	const portDropdownKey = amebaSerialPorts.length

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
			const details = [`Sdk Path: ${amebaSdkRoot}`, `Toolchain: ${amebaToolChainEnv}`, `Sdk Ver: v${amebaSdkVersion}`]
			return details.join("\n")
		}
		return disabledTooltipText
	}

	const chipTooltipText = getChipTooltipText()

	const chipTooltipStyle: React.CSSProperties = {
		left: "0px",
		zIndex: 1001,
		minWidth: "180px", // 設定一個足夠的最小寬度，您可以根據需要微調
		whiteSpace: "pre-wrap", // 關鍵屬性：保留換行符並防止不必要的自動換行
		textAlign: "left", // 確保文字靠左對齊
	}

	const dropdownTooltipStyle: React.CSSProperties = {
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: 1001,
		whiteSpace: "nowrap",
	}

	const iconButtonTooltipStyle = isAmebaSdkReady ? undefined : chipTooltipStyle

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

			<Tooltip
				style={isAmebaSdkReady ? dropdownTooltipStyle : chipTooltipStyle}
				tipText={isAmebaSdkReady ? "Select Chip" : disabledTooltipText}>
				{/* --- [核心修改] 將 onFocus 改為 onMouseDown --- */}
				<StyledLinkDropdown
					disabled={!isAmebaSdkReady}
					onBlur={handleIcDropdownClose}
					onChange={handleIcSelectionChange}
					onMouseDown={handleIcDropdownToggle}
					style={{ minWidth: icDropdownWidth }}
					value={amebaIcSelection || ""}>
					{(amebaIcVariants || []).map((variant) => (
						<StyledOption key={variant} onClick={handleIcDropdownClose} value={variant}>
							{variant}
						</StyledOption>
					))}
				</StyledLinkDropdown>
			</Tooltip>

			<Tooltip
				style={isAmebaSdkReady ? dropdownTooltipStyle : chipTooltipStyle}
				tipText={isAmebaSdkReady ? "Select Serial Port" : disabledTooltipText}>
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

			<Tooltip style={iconButtonTooltipStyle} tipText={isAmebaSdkReady ? "Ameba Menuconfig" : disabledTooltipText}>
				<VSCodeButton
					appearance="icon"
					aria-label="Ameba Menuconfig"
					disabled={!isAmebaSdkReady}
					onClick={handleMenuConfigClick}>
					<span className="codicon codicon-checklist" />
				</VSCodeButton>
			</Tooltip>

			<Tooltip style={iconButtonTooltipStyle} tipText={isAmebaSdkReady ? "Ameba Build" : disabledTooltipText}>
				<VSCodeButton appearance="icon" aria-label="Ameba Build" disabled={!isAmebaSdkReady} onClick={handleBuildClick}>
					<span className="codicon codicon-tools" />
				</VSCodeButton>
			</Tooltip>

			<Tooltip style={iconButtonTooltipStyle} tipText={isAmebaSdkReady ? "Ameba Flash" : disabledTooltipText}>
				<VSCodeButton appearance="icon" aria-label="Ameba Flash" disabled={!isAmebaSdkReady} onClick={handleFlashClick}>
					<span className="codicon codicon-symbol-event" />
				</VSCodeButton>
			</Tooltip>

			<Tooltip style={iconButtonTooltipStyle} tipText={isAmebaSdkReady ? "Ameba Monitor" : disabledTooltipText}>
				<VSCodeButton
					appearance="icon"
					aria-label="Ameba Monitor"
					disabled={!isAmebaSdkReady}
					onClick={handleMonitorClick}>
					<span className="codicon codicon-vm" />
				</VSCodeButton>
			</Tooltip>

			<Tooltip tipText="Ameba Documents">
				<VSCodeButton appearance="icon" aria-label="Ameba Doc" onClick={handleOpenDocsClick}>
					<span className="codicon codicon-book" />
				</VSCodeButton>
			</Tooltip>
		</ControlsRow>
	)
}

export default AmebaServiceModal
