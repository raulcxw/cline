import { AmebaExample } from "@shared/amebaInfo"
import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useMemo, useRef, useState } from "react"
import styled from "styled-components"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { AmebaServiceClient } from "@/services/grpc-client"
import Tooltip from "../common/Tooltip"

// --- 全局容器與行列樣式 (無變更) ---
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
const SecondControlsRow = styled(ControlsRow)`
	padding-left: 38px; /* 根據第一行圖標和間距調整，使其對齊 */
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

// --- [核心修改] 為觸發按鈕新增邊框與圓角 ---
const DropdownTriggerButton = styled.button`
	background: transparent;
	/* border: none; */ /* 移除此行 */
	border: 1px solid var(--vscode-dropdown-border); /* 新增邊框，使用主題變數 */
	border-radius: 3px; /* 新增小圓角 */
	color: var(--vscode-descriptionForeground);
	font-size: 12px;
	font-family: var(--vscode-font-family);
	text-align: center;
	padding: 2px 4px;
	transition: all 0.2s ease;
	cursor: pointer;

	&:hover:not(:disabled) {
		color: var(--vscode-foreground);
		text-decoration: underline;
		border-color: var(--vscode-focusBorder); /* 滑鼠懸停時邊框顏色可以更明顯 */
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

// --- 選項的 Styled Components (無變更) ---
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

// --- 範例選單專用的 Styled Components (無變更) ---
const CategoryHeader = styled.div`
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 6px 8px;
	cursor: pointer;
	font-size: 12px;
	user-select: none;
	color: var(--vscode-foreground);
	border-radius: 2px;
	font-weight: bold;

	&:hover {
		background: var(--vscode-list-hoverBackground);
	}
`

const ChevronIcon = styled.span<{ $isExpanded: boolean }>`
	font-size: 12px;
	margin-left: 8px;
	transform: ${(props) => (props.$isExpanded ? "rotate(90deg)" : "rotate(0deg)")};
	transition: transform 0.2s ease-in-out;
`

const ExampleDropdownOption = styled(DropdownOption)`
	padding-left: 24px;
`

// --- 寬度計算函式 (無變更) ---
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

	// --- 狀態管理 ---
	const [isIcDropdownOpen, setIsIcDropdownOpen] = useState(false)
	const [isPortDropdownOpen, setIsPortDropdownOpen] = useState(false)
	const [isExampleDropdownOpen, setIsExampleDropdownOpen] = useState(false)
	const [expandedCategories, setExpandedCategories] = useState<Record<string, boolean>>({})

	// --- Refs 用於偵測點擊外部及手動失焦 ---
	const icDropdownRef = useRef<HTMLDivElement>(null)
	const portDropdownRef = useRef<HTMLDivElement>(null)
	const exampleDropdownRef = useRef<HTMLDivElement>(null)

	const isAmebaSdkReady = !!(amebaSdkRoot && amebaToolChainEnv)
	const FONT_STYLE = "12px var(--vscode-font-family, sans-serif)"

	// --- 寬度計算 (無變更) ---
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
	}, [amebaSelectedSerialPort, amebaSerialPorts])
	const portButtonWidth = isPortDropdownOpen ? longestPortWidth : selectedPortWidth

	const { groupedExamples, exampleCategories } = useMemo(() => {
		if (!amebaExamples) return { groupedExamples: {}, exampleCategories: [] }
		const groups = amebaExamples.reduce(
			(acc, example) => {
				const category = example.category || "General"
				if (!acc[category]) {
					acc[category] = []
				}
				acc[category].push(example)
				return acc
			},
			{} as Record<string, AmebaExample[]>,
		)
		return { groupedExamples: groups, exampleCategories: Object.keys(groups) }
	}, [amebaExamples])

	const openExampleDropdownWidth = useMemo(() => {
		if (!exampleCategories.length) return calculateTextWidth("No example", FONT_STYLE)
		let maxWidth = 0
		const calculate = (text: string) => parseInt(calculateTextWidth(text, FONT_STYLE), 10)
		const longestCategory = exampleCategories.reduce((a, b) => (a.length > b.length ? a : b), "")
		maxWidth = calculate(longestCategory)
		Object.keys(expandedCategories).forEach((category) => {
			if (expandedCategories[category] && groupedExamples[category]) {
				const longestExampleInCategory = groupedExamples[category].reduce(
					(a, b) => (a.name.length > b.name.length ? a : b),
					{
						name: "",
					},
				)
				if (longestExampleInCategory.name) {
					const exampleWidth = calculate(longestExampleInCategory.name)
					if (exampleWidth > maxWidth) {
						maxWidth = exampleWidth
					}
				}
			}
		})
		return `${maxWidth + 10}px`
	}, [exampleCategories, groupedExamples, expandedCategories])

	const selectedExampleWidth = useMemo(
		() => calculateTextWidth(amebaSelectedExample?.name || "Select Example", FONT_STYLE),
		[amebaSelectedExample],
	)

	const exampleButtonWidth = isExampleDropdownOpen ? openExampleDropdownWidth : selectedExampleWidth

	// --- 統一處理點擊外部關閉事件的 Hook (無變更) ---
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

	// --- 事件處理器 (包含手動失焦邏輯) ---
	const handleIcDropdownToggle = () => setIsIcDropdownOpen((c) => !c)
	const handlePortDropdownToggle = () => setIsPortDropdownOpen((c) => !c)
	const handleExampleDropdownToggle = () => {
		setIsExampleDropdownOpen((c) => !c)
		if (isExampleDropdownOpen) {
			setExpandedCategories({})
		}
	}

	const handleCategoryToggle = (category: string) => {
		setExpandedCategories((prev) => ({
			...prev,
			[category]: !prev[category],
		}))
	}

	const handleIcSelection = async (newIc: string) => {
		icDropdownRef.current?.querySelector("button")?.blur() // 手動失焦解決 Tooltip 殘留問題
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
		portDropdownRef.current?.querySelector("button")?.blur() // 手動失焦
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
		exampleDropdownRef.current?.querySelector("button")?.blur() // 手動失焦
		if (examplePath && examplePath !== amebaSelectedExample?.path) {
			try {
				await AmebaServiceClient.amebaUpdateExample(StringRequest.create({ value: examplePath }))
			} catch (error) {
				console.error("Failed to update Ameba Example selection:", error)
			}
		}
		setIsExampleDropdownOpen(false)
	}

	// --- 其他按鈕處理器 (無變更) ---
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

	// --- Tooltip 相關 (無變更) ---
	const getDisabledTooltipText = (): string => {
		const sdkError = "Ameba SDK not found. Please open an SDK project folder or set the path manually."
		const toolchainError = "Ameba Toolchain directory and Prebuilts check failed. Please verify the installation."
		const errors: string[] = []
		if (!amebaSdkRoot) {
			errors.push(sdkError)
		} else if (!amebaToolChainEnv) {
			errors.push(toolchainError)
		}
		return errors.length === 0 ? "Ameba SDK environment is ready." : errors.join("\n")
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

	// --- 渲染部分 (無變更) ---
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
				</Tooltip>

				<Tooltip
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
							<DropdownListbox style={{ minWidth: openExampleDropdownWidth }}>
								{amebaExamples.length === 0 ? (
									<DropdownOption style={{ cursor: "default", color: "var(--vscode-disabledForeground)" }}>
										No example found
									</DropdownOption>
								) : (
									exampleCategories.map((category) => (
										<React.Fragment key={category}>
											<CategoryHeader onClick={() => handleCategoryToggle(category)}>
												{category}
												<ChevronIcon
													$isExpanded={!!expandedCategories[category]}
													className="codicon codicon-chevron-right"
												/>
											</CategoryHeader>
											{expandedCategories[category] &&
												groupedExamples[category].map((example) => (
													<ExampleDropdownOption
														key={example.path}
														onClick={() => handleExampleSelection(example.path)}>
														{example.name}
													</ExampleDropdownOption>
												))}
										</React.Fragment>
									))
								)}
							</DropdownListbox>
						)}
					</CustomDropdownContainer>
				</Tooltip>
			</ControlsRow>

			<SecondControlsRow>
				<Tooltip
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
