import * as Tooltip from '@radix-ui/react-tooltip'

/** Styled hover tooltip for icon buttons. Wrap the trigger element with asChild. */
export function Tip({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          className="z-[100] rounded-md border border-edge bg-surface-2 px-2.5 py-1.5 text-[11.5px] font-medium text-ink-0 shadow-xl"
          sideOffset={6}
        >
          {label}
          <Tooltip.Arrow className="fill-surface-2" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  )
}
