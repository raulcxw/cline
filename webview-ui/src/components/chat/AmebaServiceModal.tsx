import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import React from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AmebaServiceClient } from "@/services/grpc-client"
import Tooltip from "../common/Tooltip" // 請確保此路徑正確

// --- Styled Components (此處的 CSS 分號必須保留) ---
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

	// 刪除這裡的日誌，或者您可以保留它們以供除錯
	// console.log("[Frontend] React component rerendered.");
	// console.log("[Frontend] Received from context: amebaSelectedSerialPort =", amebaSelectedSerialPort);
	// console.log("[Frontend] Passing to Dropdown value prop:", amebaSelectedSerialPort || "");

	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)

	// --- Event Handlers ---
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

	// --- [新增] 為串口下拉選單生成一個獨一無二的 key ---
	// 當串口列表的內容發生任何變化時，這個 key 都會跟著改變。
	const portDropdownKey = amebaSerialPorts.map((p) => p.path).join(",")

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
				<StyledLinkDropdown
					disabled={!isAmebaSdkReady}
					onChange={handleIcSelectionChange}
					style={{ minWidth: "75px" }}
					value={amebaIcSelection}>
					{(amebaIcVariants || []).map((variant) => (
						<StyledOption key={variant} value={variant}>
							{variant}
						</StyledOption>
					))}
				</StyledLinkDropdown>
			</Tooltip>

			<Tooltip style={dropdownTooltipStyle} tipText={isAmebaSdkReady ? "Select Serial Port" : disabledTooltipText}>
				<StyledLinkDropdown
					// --- [修改] 在此處添加 key 屬性 ---
					// 這會強制 React 在串口列表變化時重新創建一個全新的 Dropdown 元件
					// 從而解決元件內部狀態導致的顯示不一致問題。
					disabled={!isAmebaSdkReady}
					key={portDropdownKey}
					onChange={handlePortSelectionChange}
					style={{ minWidth: "45px" }}
					value={amebaSelectedSerialPort || ""}>
					{amebaSerialPorts.length === 0 ? (
						<StyledOption disabled value="">
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
