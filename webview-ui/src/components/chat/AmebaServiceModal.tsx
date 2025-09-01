import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useRef, useState } from "react"
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

const AmebaServiceModal: React.FC = () => {
	const { amebaSdkRoot, amebaToolChainEnv, amebaIcSelection, amebaIcVariants, amebaSerialPorts, amebaSelectedSerialPort } =
		useExtensionState()

	// 新增：状态更新锁，防止并发调用
	const [isUpdating, setIsUpdating] = useState(false)
	// 新增：下拉框DOM引用
	const icDropdownRef = useRef<HTMLSelectElement>(null)
	const portDropdownRef = useRef<HTMLSelectElement>(null)

	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)

	// --- 新增：强制同步下拉框状态 ---
	useEffect(() => {
		if (icDropdownRef.current && icDropdownRef.current.value !== amebaIcSelection) {
			icDropdownRef.current.value = amebaIcSelection || ""
		}
	}, [amebaIcSelection])

	useEffect(() => {
		if (portDropdownRef.current && portDropdownRef.current.value !== amebaSelectedSerialPort) {
			portDropdownRef.current.value = amebaSelectedSerialPort || ""
		}
	}, [amebaSelectedSerialPort])

	// 优化：仅在串口数量变化时重建组件
	const portDropdownKey = amebaSerialPorts.length

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

	// 修复：添加状态锁防止循环调用
	const handleIcSelectionChange = async (e: any) => {
		const newIc = e.target.value
		if (newIc && newIc !== amebaIcSelection && !isUpdating) {
			setIsUpdating(true)
			try {
				await AmebaServiceClient.amebaUpdateChipSelection(StringRequest.create({ value: newIc }))
			} catch (error) {
				console.error("Failed to update Ameba Chip selection:", error)
			} finally {
				setIsUpdating(false)
			}
		}
	}

	// 修复：添加状态锁防止循环调用
	const handlePortSelectionChange = async (e: any) => {
		const selectedValue = e.target.value
		if (selectedValue !== amebaSelectedSerialPort && !isUpdating) {
			setIsUpdating(true)
			try {
				await AmebaServiceClient.amebaUpdateSerialPort(StringRequest.create({ value: selectedValue }))
			} catch (error) {
				console.error("Failed to update Ameba Serial Port:", error)
			} finally {
				setIsUpdating(false)
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
					disabled={!isAmebaSdkReady} // 绑定ref
					onChange={handleIcSelectionChange}
					ref={icDropdownRef}
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
					disabled={!isAmebaSdkReady} // 绑定ref
					key={portDropdownKey}
					onChange={handlePortSelectionChange}
					ref={portDropdownRef}
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
