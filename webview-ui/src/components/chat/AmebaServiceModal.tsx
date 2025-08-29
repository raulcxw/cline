import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import React from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AmebaServiceClient } from "@/services/grpc-client"
import Tooltip from "../common/Tooltip" // Ensure the path is correct

// --- (Styled Components - Unchanged) ---
const StyledLinkDropdown = styled(VSCodeDropdown)`
	min-width: 80px;
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

const SerialPortDropdown = styled(VSCodeDropdown)`
	min-width: 60px;
	max-width: 120px;
	&::part(listbox) {
		z-index: 9999;
	}
`
// --- (Styled Components End) ---

// Define a unique value for the "manual scan" option that won't conflict with real serial ports
const MANUAL_SCAN_VALUE = "__MANUAL_SCAN__"

const AmebaServiceModal: React.FC = () => {
	const { amebaSdkRoot, amebaToolChainEnv, amebaIcSelection, amebaIcVariants, amebaSerialPorts, amebaSelectedSerialPort } =
		useExtensionState()

	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)

	// --- Event Handlers (Unchanged) ---
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
				console.error("Failed to update Ameba IC selection:", error)
			}
		}
	}

	const handlePortSelectionChange = async (e: any) => {
		const selectedValue = e.target.value
		if (selectedValue === MANUAL_SCAN_VALUE) {
			try {
				await AmebaServiceClient.amebaRefreshSerialPorts(EmptyRequest.create())
			} catch (error) {
				console.error("Failed to refresh serial ports manually:", error)
			}
			return
		}

		if (selectedValue !== amebaSelectedSerialPort) {
			try {
				await AmebaServiceClient.amebaUpdateSerialPort(StringRequest.create({ value: selectedValue }))
			} catch (error) {
				console.error("Failed to update Ameba Serial Port:", error)
			}
		}
	}
	// --- Event Handlers End ---

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

	// 为不同元素定义不同的Tooltip样式
	const chipTooltipStyle: React.CSSProperties = {
		left: "0px", // 仅芯片图标需要这个样式
		zIndex: 1001,
	}

	// 下拉框的Tooltip样式 - 居中显示
	const dropdownTooltipStyle: React.CSSProperties = {
		left: "50%", // 水平居中
		transform: "translateX(-50%)", // 水平居中
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

			{/* 为IC选择下拉框添加居中样式 */}
			<Tooltip style={dropdownTooltipStyle} tipText={isAmebaSdkReady ? "Select IC" : disabledTooltipText}>
				<StyledLinkDropdown disabled={!isAmebaSdkReady} onChange={handleIcSelectionChange} value={amebaIcSelection}>
					{(amebaIcVariants || []).map((variant) => (
						<StyledOption key={variant} value={variant}>
							{variant}
						</StyledOption>
					))}
				</StyledLinkDropdown>
			</Tooltip>

			{/* 为串口选择下拉框添加居中样式 */}
			<Tooltip style={dropdownTooltipStyle} tipText={isAmebaSdkReady ? "Select Serial Port" : disabledTooltipText}>
				<SerialPortDropdown
					disabled={!isAmebaSdkReady}
					onChange={handlePortSelectionChange}
					value={amebaSelectedSerialPort || ""}>
					<StyledOption value={MANUAL_SCAN_VALUE}>Scan Manually</StyledOption>
					<StyledOption disabled>──────────</StyledOption>
					<StyledOption value="">{amebaSerialPorts.length > 0 ? "" : "No port found"}</StyledOption>
					{amebaSerialPorts.map((port) => (
						<StyledOption key={port.path} value={port.path}>
							{port.path}
						</StyledOption>
					))}
				</SerialPortDropdown>
			</Tooltip>

			{/* 其他控制按钮保持不变 */}
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
