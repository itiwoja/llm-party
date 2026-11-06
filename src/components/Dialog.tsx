import * as RadixDialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";

interface Props {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: string;
  description?: string;
  /** false なら Esc と外側のクリックで閉じない（トークンの入力など） */
  dismissible?: boolean;
  children?: ReactNode;
  /** 右寄せのボタン列。主ボタンは最後 */
  footer?: ReactNode;
}

/** CMP-019。消す操作の主ボタンは danger にする */
export function Dialog({ open, onOpenChange, title, description, dismissible = true, children, footer }: Props) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-scrim" />
        <RadixDialog.Content
          className="dialog"
          {...(description ? {} : { "aria-describedby": undefined })}
          onEscapeKeyDown={(e) => { if (!dismissible) e.preventDefault(); }}
          onPointerDownOutside={(e) => { if (!dismissible) e.preventDefault(); }}
          onInteractOutside={(e) => { if (!dismissible) e.preventDefault(); }}
        >
          <RadixDialog.Title className="dialog-title">{title}</RadixDialog.Title>
          {description ? <RadixDialog.Description className="dialog-description">{description}</RadixDialog.Description> : null}
          {children}
          {footer ? <div className="dialog-footer">{footer}</div> : null}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
