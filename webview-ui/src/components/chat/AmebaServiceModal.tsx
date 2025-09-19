import { AmebaExample } from "@shared/amebaInfo"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AmebaServiceClient } from "@/services/grpc-client"
import Tooltip from "../common/Tooltip"

// --- 全局容器與行列樣式 ---
const Container = styled.div`
	display: flex;
	flex-direction: column;
	gap: 4px; /* 行之間的間距 */
	padding-bottom: 8px; /* 底部整體邊距 */
`
const ControlsRow = styled.div`
	display: flex;
	align-items: center;
	gap: 8px;
	padding: 0 15px;
	font-size: 12px;
	color: var(--vscode-descriptionForeground);
`

const AlignerButton = styled.div`
	display: inline-flex;
	align-items: center;
	justify-content: center;
	box-sizing: border-box;
	width: calc(1em + 12px); /* 模擬 VSCodeButton 的寬度 */
	height: calc(1.5em + 10px); /* 模擬 VSCodeButton 的高度 */
	padding: 0px; /* 模擬 VSCodeButton 的內邊距 */
	background: transparent;
	border: none;
	cursor: default; /* 保持預設游標 */
	pointer-events: none; /* 不回應滑鼠事件 */

	/* 確保內部的圖示垂直居中 */
	& > .codicon {
		vertical-align: middle;
	}
`

const ButtonGroup = styled.div`
	display: flex;
	align-items: center;
	gap: 4px;
`

// --- 自訂下拉選單的通用 Styled Components ---
const CustomDropdownContainer = styled.div`
	position: relative;
	display: inline-block;
`

const DropdownTriggerButton = styled.button`
	background: transparent;
	border: 1px solid var(--vscode-dropdown-border);
	border-radius: 3px;
	color: var(--vscode-descriptionForeground);
	font-size: 13px;
	font-family: var(--vscode-font-family);
	text-align: center;
	padding: 2px 4px;
	transition: all 0.2s ease;
	cursor: pointer;

	&:hover:not(:disabled) {
		color: var(--vscode-foreground);
		text-decoration: underline;
		border-color: var(--vscode-focusBorder);
	}

	&:disabled {
		cursor: not-allowed;
		opacity: 0.6;
	}
`

const DropdownListbox = styled.div`
	position: absolute;
	bottom: 100%;
	left: 50%;
	transform: translateX(-50%);
	z-index: 9999;
	background: var(--vscode-dropdown-background);
	border: 1px solid var(--vscode-dropdown-border);
	border-radius: 3px;
	margin-bottom: 4px;
	padding: 4px;
	box-shadow: 0 -4px 8px rgba(0, 0, 0, 0.2);
	max-height: 400px;
	overflow-y: auto;
`

const DropdownOption = styled.div`
	background: transparent;
	color: var(--vscode-foreground);
	font-size: 12px;
	padding: 6px 8px;
	cursor: pointer;
	border-radius: 2px;
	white-space: nowrap;

	&:hover {
		background: var(--vscode-list-hoverBackground);
	}
`

// --- 遞迴樹狀範例選單專用樣式 ---
const NodeContainer = styled.div<{ $isClickable: boolean }>`
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 6px 8px;
	cursor: ${(props) => (props.$isClickable ? "pointer" : "default")};
	font-size: 12px;
	user-select: none;
	color: var(--vscode-foreground);
	border-radius: 2px;
	white-space: nowrap;

	&:hover {
		background: var(--vscode-list-hoverBackground);
	}
`

const NodeLabel = styled.span`
	flex-grow: 1;
`

const ChevronIcon = styled.span<{ $isExpanded: boolean }>`
	font-size: 12px;
	margin-left: 8px;
	flex-shrink: 0;
	transform: ${(props) => (props.$isExpanded ? "rotate(90deg)" : "rotate(0deg)")};
	transition: transform 0.2s ease-in-out;
	cursor: pointer;
`
const PlaceholderIcon = styled.span`
	font-size: 12px;
	margin-left: 8px;
	flex-shrink: 0;
	width: 1em; /* 佔位，與 ChevronIcon 對齊 */
`

// --- 寬度計算函式 ---
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

// --- 樹狀結構的型別定義 ---
interface ExampleTreeNode {
	children: { [key: string]: ExampleTreeNode }
	isExample: boolean
	data?: AmebaExample
}

// --- 遞迴渲染元件 ---
const RecursiveExampleNode: React.FC<{
	name: string
	node: ExampleTreeNode
	level: number
	onSelect: (path: string) => void
}> = ({ name, node, level, onSelect }) => {
	const [isExpanded, setIsExpanded] = useState(false)
	const hasChildren = Object.keys(node.children).length > 0

	const handleNodeClick = () => {
		if (node.isExample && node.data) {
			onSelect(node.data.path)
		} else if (hasChildren) {
			setIsExpanded(!isExpanded)
		}
	}

	const handleChevronClick = (e: React.MouseEvent) => {
		e.stopPropagation()
		if (hasChildren) {
			setIsExpanded(!isExpanded)
		}
	}

	return (
		<>
			<NodeContainer
				$isClickable={node.isExample || hasChildren}
				onClick={handleNodeClick}
				style={{ paddingLeft: `${8 + level * 16}px` }}>
				<NodeLabel>{name}</NodeLabel>
				{hasChildren ? (
					<ChevronIcon
						$isExpanded={isExpanded}
						className="codicon codicon-chevron-right"
						onClick={handleChevronClick}
					/>
				) : (
					<PlaceholderIcon />
				)}
			</NodeContainer>
			{isExpanded &&
				hasChildren &&
				Object.entries(node.children)
					.sort(([a], [b]) => a.localeCompare(b))
					.map(([childName, childNode]) => (
						<RecursiveExampleNode
							key={childName}
							level={level + 1}
							name={childName}
							node={childNode}
							onSelect={onSelect}
						/>
					))}
		</>
	)
}

const MaybeTooltip: React.FC<{
	disabled: boolean
	tipText: string
	style?: React.CSSProperties
	children: React.ReactNode
}> = ({ disabled, tipText, style, children }) => {
	if (disabled) return <>{children}</>
	return (
		<Tooltip style={style} tipText={tipText}>
			{children}
		</Tooltip>
	)
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

	// --- 狀態管理 ---
	const [isIcDropdownOpen, setIsIcDropdownOpen] = useState(false)
	const [isPortDropdownOpen, setIsPortDropdownOpen] = useState(false)
	const [isExampleDropdownOpen, setIsExampleDropdownOpen] = useState(false)

	// --- Refs ---
	const icDropdownRef = useRef<HTMLDivElement>(null)
	const portDropdownRef = useRef<HTMLDivElement>(null)
	const exampleDropdownRef = useRef<HTMLDivElement>(null)

	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)
	const FONT_STYLE = "12px var(--vscode-font-family, sans-serif)"

	// --- 寬度計算 ---
	const longestIcWidth = useMemo(() => {
		if (!amebaIcVariants || amebaIcVariants.length === 0) {
			return "75px"
		}
		const longestVariant = amebaIcVariants.reduce((a, b) => (a.length > b.length ? a : b), "")
		return calculateTextWidth(longestVariant, FONT_STYLE)
	}, [amebaIcVariants])
	const selectedIcWidth = useMemo(() => {
		return calculateTextWidth(amebaIcSelection || "Select Chip", FONT_STYLE)
	}, [amebaIcSelection])
	const icButtonWidth = isIcDropdownOpen ? longestIcWidth : selectedIcWidth

	const longestPortWidth = useMemo(() => {
		if (!amebaSerialPorts || amebaSerialPorts.length === 0) {
			return calculateTextWidth("No port found", FONT_STYLE)
		}
		const longestPort = amebaSerialPorts.reduce((a, b) => (a.path.length > b.path.length ? a : b))
		return calculateTextWidth(longestPort.path, FONT_STYLE)
	}, [amebaSerialPorts])
	const selectedPortWidth = useMemo(() => {
		const text = amebaSelectedSerialPort?.path || "Select Port"
		return calculateTextWidth(text, FONT_STYLE)
	}, [amebaSelectedSerialPort])
	const portButtonWidth = isPortDropdownOpen ? longestPortWidth : selectedPortWidth

	const selectedExampleWidth = useMemo(
		() => calculateTextWidth(amebaSelectedExample?.name || "Select Example", FONT_STYLE),
		[amebaSelectedExample],
	)

	const exampleButtonWidth = selectedExampleWidth
	const exampleDropdownMinWidth = "200px"

	// --- 將扁平列表轉換為樹狀結構 ---
	const exampleTree = useMemo(() => {
		if (!amebaExamples) return {}
		const root: { [key: string]: ExampleTreeNode } = {}

		for (const example of amebaExamples) {
			const parts = example.path.split("/")
			let currentNodeChildren = root

			for (let i = 0; i < parts.length; i++) {
				const part = parts[i]
				if (!currentNodeChildren[part]) {
					currentNodeChildren[part] = { children: {}, isExample: false }
				}
				const currentNode = currentNodeChildren[part]

				if (i < parts.length - 1) {
					currentNodeChildren = currentNode.children
				} else {
					// 這是路徑的最後一部分，標記為範例
					currentNode.isExample = true
					currentNode.data = example
				}
			}
		}
		return root
	}, [amebaExamples])

	// --- 點擊外部關閉 Hook ---
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node
			if (icDropdownRef.current && !icDropdownRef.current.contains(target)) {
				setIsIcDropdownOpen(false)
			}
			if (portDropdownRef.current && !portDropdownRef.current.contains(target)) {
				setIsPortDropdownOpen(false)
			}
			if (exampleDropdownRef.current && !exampleDropdownRef.current.contains(target)) {
				setIsExampleDropdownOpen(false)
			}
		}
		document.addEventListener("mousedown", handleClickOutside)
		return () => {
			document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [])

	// --- 事件處理器 ---
	const handleIcDropdownToggle = () => setIsIcDropdownOpen((c) => !c)
	const handlePortDropdownToggle = () => setIsPortDropdownOpen((c) => !c)
	const handleExampleDropdownToggle = () => setIsExampleDropdownOpen((c) => !c)

	const handleIcSelection = async (newIc: string) => {
		icDropdownRef.current?.querySelector("button")?.blur()
		if (newIc && newIc !== amebaIcSelection) {
			try {
				await AmebaServiceClient.amebaUpdateChipSelection(StringRequest.create({ value: newIc }))
			} catch (error) {
				console.error("Failed to update Ameba Chip selection:", error)
			}
		}
		setIsIcDropdownOpen(false)
	}

	const handlePortSelection = async (selectedPortPath: string) => {
		portDropdownRef.current?.querySelector("button")?.blur()
		if (selectedPortPath !== amebaSelectedSerialPort?.path) {
			try {
				await AmebaServiceClient.amebaUpdateSerialPort(StringRequest.create({ value: selectedPortPath }))
			} catch (error) {
				console.error("Failed to update Ameba Serial Port:", error)
			}
		}
		setIsPortDropdownOpen(false)
	}

	const handleExampleSelection = async (examplePath: string) => {
		exampleDropdownRef.current?.querySelector("button")?.blur()
		// 即使是當前選中的範例，也允許再次發送請求，以應對後端狀態可能不一致的情況
		try {
			await AmebaServiceClient.amebaUpdateExample(StringRequest.create({ value: examplePath }))
		} catch (error) {
			console.error("Failed to update Ameba Example selection:", error)
		}
		setIsExampleDropdownOpen(false)
	}

	// --- 其他按鈕處理器 ---
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

	// --- Tooltip 相關 ---
	const getDisabledTooltipText = (): string => {
		const sdkError = "Ameba SDK not found. Please open an SDK project folder."
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

	const buttonTooltipStyle: React.CSSProperties = {
		left: "0px",
		zIndex: 1001,
		minWidth: "50px",
		whiteSpace: "pre-wrap",
		textAlign: "left",
	}

	const dropdownTooltipStyle: React.CSSProperties = {
		left: "50%",
		transform: "translateX(-50%)",
		zIndex: 1001,
		whiteSpace: "nowrap",
	}

	const iconButtonTooltipStyle = isAmebaSdkReady ? buttonTooltipStyle : chipTooltipStyle

	// --- 渲染部分 ---
	return (
		<Container>
			<ControlsRow>
				<Tooltip style={chipTooltipStyle} tipText={chipTooltipText}>
					<AlignerButton>
						<span
							className="codicon codicon-chip"
							style={{
								fontSize: "16px",
								verticalAlign: "middle",
								cursor: "default",
								color: isAmebaSdkReady ? "var(--vscode-textLink-foreground)" : "var(--vscode-disabledForeground)",
							}}></span>
					</AlignerButton>
				</Tooltip>

				<MaybeTooltip
					disabled={isAmebaSdkReady && isIcDropdownOpen}
					style={isAmebaSdkReady ? dropdownTooltipStyle : chipTooltipStyle}
					tipText={isAmebaSdkReady ? "Select Chip" : disabledTooltipText}>
					<CustomDropdownContainer ref={icDropdownRef}>
						<DropdownTriggerButton
							disabled={!isAmebaSdkReady}
							onClick={handleIcDropdownToggle}
							style={{ minWidth: icButtonWidth }}>
							{amebaIcSelection || "Select Chip"}
						</DropdownTriggerButton>
						{isIcDropdownOpen && (
							<DropdownListbox style={{ minWidth: longestIcWidth }}>
								{(amebaIcVariants || []).map((variant) => (
									<DropdownOption key={variant} onClick={() => handleIcSelection(variant)}>
										{variant}
									</DropdownOption>
								))}
							</DropdownListbox>
						)}
					</CustomDropdownContainer>
				</MaybeTooltip>

				<MaybeTooltip
					disabled={isAmebaSdkReady && isPortDropdownOpen}
					style={isAmebaSdkReady ? dropdownTooltipStyle : chipTooltipStyle}
					tipText={isAmebaSdkReady ? "Select Serial Port" : disabledTooltipText}>
					<CustomDropdownContainer ref={portDropdownRef}>
						<DropdownTriggerButton
							disabled={!isAmebaSdkReady}
							onClick={handlePortDropdownToggle}
							style={{ minWidth: portButtonWidth }}>
							{amebaSelectedSerialPort?.path || "Select Port"}
						</DropdownTriggerButton>
						{isPortDropdownOpen && (
							<DropdownListbox style={{ minWidth: longestPortWidth }}>
								{amebaSerialPorts.length === 0 ? (
									<DropdownOption style={{ cursor: "default", color: "var(--vscode-disabledForeground)" }}>
										No port found
									</DropdownOption>
								) : (
									amebaSerialPorts.map((port) => (
										<DropdownOption key={port.path} onClick={() => handlePortSelection(port.path)}>
											{port.path}
										</DropdownOption>
									))
								)}
							</DropdownListbox>
						)}
					</CustomDropdownContainer>
				</MaybeTooltip>

				<MaybeTooltip
					disabled={isAmebaSdkReady && isExampleDropdownOpen}
					style={isAmebaSdkReady ? dropdownTooltipStyle : chipTooltipStyle}
					tipText={isAmebaSdkReady ? "Select Example" : disabledTooltipText}>
					<CustomDropdownContainer ref={exampleDropdownRef}>
						<DropdownTriggerButton
							disabled={!isAmebaSdkReady}
							onClick={handleExampleDropdownToggle}
							style={{ minWidth: exampleButtonWidth }}>
							{amebaSelectedExample?.name || "Select Example"}
						</DropdownTriggerButton>

						{isExampleDropdownOpen && (
							<DropdownListbox style={{ minWidth: exampleDropdownMinWidth }}>
								{!amebaExamples || amebaExamples.length === 0 ? (
									<DropdownOption style={{ cursor: "default", color: "var(--vscode-disabledForeground)" }}>
										No example found
									</DropdownOption>
								) : (
									<>
										<DropdownOption key="default-example" onClick={() => handleExampleSelection("")}>
											None
										</DropdownOption>
										{Object.entries(exampleTree)
											.sort(([a], [b]) => a.localeCompare(b))
											.map(([name, node]) => (
												<RecursiveExampleNode
													key={name}
													level={0}
													name={name}
													node={node}
													onSelect={handleExampleSelection}
												/>
											))}
									</>
								)}
							</DropdownListbox>
						)}
					</CustomDropdownContainer>
				</MaybeTooltip>
			</ControlsRow>

			<ControlsRow>
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
			</ControlsRow>
		</Container>
	)
}

export default AmebaServiceModal
