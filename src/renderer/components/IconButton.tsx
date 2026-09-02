import * as Tooltip from "@radix-ui/react-tooltip";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  children: ReactNode;
};

export function IconButton({
  label,
  children,
  onPointerDown,
  onPointerEnter,
  onPointerLeave,
  ...props
}: IconButtonProps) {
  const [tooltipOpen, setTooltipOpen] = useState(false);

  return (
    <Tooltip.Root open={tooltipOpen} onOpenChange={(nextOpen) => {
      if (!nextOpen) setTooltipOpen(false);
    }}>
      <Tooltip.Trigger asChild>
        <button
          className="icon-button"
          aria-label={label}
          {...props}
          onPointerDown={(event) => {
            setTooltipOpen(false);
            onPointerDown?.(event);
          }}
          onPointerEnter={(event) => {
            if (event.pointerType !== "touch") setTooltipOpen(true);
            onPointerEnter?.(event);
          }}
          onPointerLeave={(event) => {
            setTooltipOpen(false);
            onPointerLeave?.(event);
          }}
        >
          {children}
        </button>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip" sideOffset={7}>
          {label}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
