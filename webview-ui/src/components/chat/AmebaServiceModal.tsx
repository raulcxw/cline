import { AmebaExample } from "@shared/amebaInfo"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton, VSCodeDropdown, VSCodeOption } from "@vscode/webview-ui-toolkit/react"
import path from "path"
import React, { useMemo, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AmebaServiceClient } from "@/services/grpc-client"
import Tooltip from "../common/Tooltip"

// 新增：主容器，用於將佈局分為多行
const Container = styled.div`
	display: flex;
	flex-direction: column;
	gap: 4px; /* 行之間的間距 */
	padding-bottom: 8px; /* 底部整體邊距 */
`

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

// 新增：用於在下拉選單中顯示分類標題的樣式
const OptGroupLabel = styled(VSCodeOption)`
	opacity: 0.7;
	font-weight: bold;
	color: var(--vscode-descriptionForeground);
	pointer-events: none; /* 使其不可點擊 */

	&::part(content) {
		font-size: 11px;
		padding-left: 4px;
		background: var(--vscode-editor-background);
	}
`

const ControlsRow = styled.div`
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 15px;
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
`

// 新增：用於第二行的 ControlsRow，增加了左邊距以對齊
const SecondControlsRow = styled(ControlsRow)`
	padding-left: 38px; /* 根據第一行圖標和間距調整，使其對齊 */
`

const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px; /* 您可以在這裡調整按鈕之間的間距，例如 4px */
`

// --- Styled Components End ---
const calculateTextWidth = (text: string | null | undefined, font: string): string => {
	const baseMinWidth = 45
	const padding = 20

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
		amebaExamples,
		amebaSelectedExample,
	} = useExtensionState()

	const [isIcDropdownOpen, setIsIcDropdownOpen] = useState(false)
	const [isPortDropdownOpen, setIsPortDropdownOpen] = useState(false)
	const [isExampleDropdownOpen, setIsExampleDropdownOpen] = useState(false)

	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)

	const FONT_STYLE = "12px var(--vscode-font-family, sans-serif)"

	// --- IC Dropdown Width Calculation ---
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

	// --- [新增] Port Dropdown Width Calculation ---
	const longestPortWidth = useMemo(() => {
		if (!amebaSerialPorts || amebaSerialPorts.length === 0) {
			return calculateTextWidth("No port found", FONT_STYLE)
		}
		const longestPort = amebaSerialPorts.reduce((a, b) => (a.path.length > b.path.length ? a : b))
		return calculateTextWidth(longestPort.path, FONT_STYLE)
	}, [amebaSerialPorts])

	const selectedPortWidth = useMemo(() => {
		const text = amebaSelectedSerialPort?.path || (amebaSerialPorts.length === 0 ? "No port found" : "")
		return calculateTextWidth(text, FONT_STYLE)
	}, [amebaSelectedSerialPort, amebaSerialPorts])

	const portDropdownWidth = isPortDropdownOpen ? longestPortWidth : selectedPortWidth

	const longestExampleWidth = useMemo(() => {
		if (!amebaExamples || amebaExamples.length === 0) return calculateTextWidth("No example", FONT_STYLE)
		const longestExample = amebaExamples.reduce((a, b) => (a.path.length > b.path.length ? a : b))
		return calculateTextWidth(longestExample.path, FONT_STYLE)
	}, [amebaExamples])
	const selectedExampleWidth = useMemo(
		() => calculateTextWidth(amebaSelectedExample?.name || "Select Example", FONT_STYLE),
		[amebaSelectedExample],
	)
	const exampleDropdownWidth = isExampleDropdownOpen ? longestExampleWidth : selectedExampleWidth

	const groupedExamples = useMemo(() => {
		if (!amebaExamples) return {}
		return amebaExamples.reduce(
			(acc, example) => {
				const category = example.category || "General" // 將沒有分類的範例歸為 "General"
				if (!acc[category]) {
					acc[category] = []
				}
				acc[category].push(example)
				return acc
			},
			{} as Record<string, AmebaExample[]>,
		)
	}, [amebaExamples])
	const exampleCategories = Object.keys(groupedExamples)

	// --- IC Dropdown Event Handlers ---
	const handleIcDropdownToggle = () => {
		setIsIcDropdownOpen((current) => !current)
	}

	const handleIcDropdownClose = () => {
		setIsIcDropdownOpen(false)
	}

	// --- [新增] Port Dropdown Event Handlers ---
	const handlePortDropdownToggle = () => {
		setIsPortDropdownOpen((current) => !current)
	}

	const handlePortDropdownClose = () => {
		setIsPortDropdownOpen(false)
	}

	const handleExampleDropdownToggle = () => setIsExampleDropdownOpen((c) => !c)
	const handleExampleDropdownClose = () => setIsExampleDropdownOpen(false)

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

	// 新增：Example Selection Change Handler
	const handleExampleSelectionChange = async (e: any) => {
		const newExamplePath = e.target.value
		console.log(`update example to:${amebaSelectedExample} ${newExamplePath}`)
		if (newExamplePath && newExamplePath !== amebaSelectedExample?.path) {
			try {
				console.log("update example to:", newExamplePath)
				await AmebaServiceClient.amebaUpdateExample(StringRequest.create({ value: newExamplePath }))
			} catch (error) {
				console.error("Failed to update Ameba Example selection:", error)
			}
		}
	}

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
		minWidth: "180px",
		whiteSpace: "pre-wrap",
		textAlign: "left",
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
		<Container>
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
					tipText={isAmebaSdkReady ? "Select Example" : disabledTooltipText}>
					<StyledLinkDropdown
						disabled={!isAmebaSdkReady}
						onBlur={handleExampleDropdownClose}
						onChange={handleExampleSelectionChange}
						onMouseDown={handleExampleDropdownToggle}
						style={{ minWidth: exampleDropdownWidth }}
						value={amebaSelectedExample?.path || ""}>
						{amebaExamples.length === 0 ? (
							<StyledOption disabled value="no-example-placeholder">
								No example found
							</StyledOption>
						) : (
							exampleCategories.map((category) => (
								<React.Fragment key={category}>
									<OptGroupLabel>{category}</OptGroupLabel>
									{groupedExamples[category].map((example) => (
										<StyledOption
											key={example.path}
											onClick={handleExampleDropdownClose}
											value={example.path}>
											{example.name}
										</StyledOption>
									))}
								</React.Fragment>
							))
						)}
					</StyledLinkDropdown>
				</Tooltip>
			</ControlsRow>

			<SecondControlsRow>
				<Tooltip
					style={isAmebaSdkReady ? dropdownTooltipStyle : chipTooltipStyle}
					tipText={isAmebaSdkReady ? "Select Serial Port" : disabledTooltipText}>
					{/* --- [修改] 將 Port Dropdown 套用動態寬度與事件處理 --- */}
					<StyledLinkDropdown
						disabled={!isAmebaSdkReady}
						key={portDropdownKey}
						onBlur={handlePortDropdownClose}
						onChange={handlePortSelectionChange}
						onMouseDown={handlePortDropdownToggle}
						style={{ minWidth: portDropdownWidth }}
						value={amebaSelectedSerialPort?.path || ""}>
						{amebaSerialPorts.length === 0 ? (
							<StyledOption disabled onClick={handlePortDropdownClose} value="no-port-placeholder">
								No port found
							</StyledOption>
						) : (
							amebaSerialPorts.map((port) => (
								<StyledOption key={port.path} onClick={handlePortDropdownClose} value={port.path}>
									{port.path}
								</StyledOption>
							))
						)}
					</StyledLinkDropdown>
				</Tooltip>

				<ButtonGroup>
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
						<VSCodeButton
							appearance="icon"
							aria-label="Ameba Build"
							disabled={!isAmebaSdkReady}
							onClick={handleBuildClick}>
							<span className="codicon codicon-tools" />
						</VSCodeButton>
					</Tooltip>

					<Tooltip style={iconButtonTooltipStyle} tipText={isAmebaSdkReady ? "Ameba Flash" : disabledTooltipText}>
						<VSCodeButton
							appearance="icon"
							aria-label="Ameba Flash"
							disabled={!isAmebaSdkReady}
							onClick={handleFlashClick}>
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
				</ButtonGroup>
			</SecondControlsRow>
		</Container>
	)
}

export default AmebaServiceModal
