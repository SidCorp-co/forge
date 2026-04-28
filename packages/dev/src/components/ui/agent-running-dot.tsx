import clsx from "clsx";

const sizeMap = { sm: "h-1.5 w-1.5", md: "h-2.5 w-2.5" };
const colorMap = { blue: "bg-blue-400", yellow: "bg-yellow-400" };
const solidColorMap = { blue: "bg-blue-500", yellow: "bg-yellow-500" };

interface AgentRunningDotProps {
  size?: "sm" | "md";
  color?: "blue" | "yellow";
}

export function AgentRunningDot({ size = "md", color = "blue" }: AgentRunningDotProps) {
  return (
    <span className={clsx("relative inline-block", sizeMap[size])}>
      <span className={clsx("absolute inset-0 animate-ping rounded-full opacity-75", colorMap[color])} />
      <span className={clsx("relative inline-block rounded-full", sizeMap[size], solidColorMap[color])} />
    </span>
  );
}
