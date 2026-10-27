import { SVGProps } from "react"
import type { Environment } from "../../../src/shared/config-types"
import { getEnvironmentColor } from "../utils/environmentColors"

/**
 * Placeholder Lumen lamp mark with theme / environment color.
 * Swap with final artwork later.
 */
const ClineLogoVariable = (props: SVGProps<SVGSVGElement> & { environment?: Environment }) => {
	const { environment, ...svgProps } = props
	const fillColor = environment ? getEnvironmentColor(environment) : "var(--vscode-icon-foreground)"

	return (
		<svg fill="none" height="50" role="img" viewBox="0 0 128 128" width="50" xmlns="http://www.w3.org/2000/svg" {...svgProps}>
			<title>Lumen</title>
			<circle cx="64" cy="48" fill={fillColor} r="28" />
			<path d="M46 70 C46 86 54 94 64 94 C74 94 82 86 82 70" fill={fillColor} opacity="0.85" />
			<rect fill={fillColor} height="14" rx="2" width="12" x="58" y="94" />
			<rect fill={fillColor} height="8" rx="3" width="32" x="48" y="108" />
			<path d="M64 12 L64 22" stroke={fillColor} strokeLinecap="round" strokeWidth="4" />
			<path d="M30 36 L38 42" stroke={fillColor} strokeLinecap="round" strokeWidth="4" />
			<path d="M98 36 L90 42" stroke={fillColor} strokeLinecap="round" strokeWidth="4" />
			<path d="M22 58 L32 58" stroke={fillColor} strokeLinecap="round" strokeWidth="4" />
			<path d="M106 58 L96 58" stroke={fillColor} strokeLinecap="round" strokeWidth="4" />
		</svg>
	)
}
export default ClineLogoVariable
