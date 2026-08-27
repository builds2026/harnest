"use client";

import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Checkbox as BaseCheckbox } from "@base-ui/react/checkbox";
import { Select as BaseSelect } from "@base-ui/react/select";
import { Switch as BaseSwitch } from "@base-ui/react/switch";
import { Toast as BaseToast } from "@base-ui/react/toast";
import { cloneElement, forwardRef, type ButtonHTMLAttributes, type HTMLAttributes, type InputHTMLAttributes, type ReactElement, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { useI18n } from "../i18n-provider";
import styles from "./ui.module.css";

const cx = (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "quiet";
  size?: "small" | "medium";
  loading?: boolean;
}>(({ className, children, variant = "default", size = "medium", loading = false, disabled, ...props }, ref) => (
  <button ref={ref} className={cx(styles.button, styles[variant], styles[size], className)} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>
    {loading && <span className={styles.spinner} aria-hidden="true" />}
    {children}
  </button>
));
Button.displayName = "Button";

export function IconButton({ label, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button type="button" className={cx(styles.iconButton, className)} aria-label={label} title={props.title ?? label} {...props}>{children}</button>;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => <input ref={ref} className={cx(styles.control, className)} {...props} />);
Input.displayName = "Input";
export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(({ className, ...props }, ref) => <select ref={ref} className={cx(styles.control, className)} {...props} />);
Select.displayName = "Select";

export function SelectControl({ label, value, options, onValueChange, disabled, className, ...triggerProps }: {
  label: string;
  value: string;
  options: readonly { value: string; label: string; disabled?: boolean }[];
  onValueChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "defaultValue" | "onChange" | "value">) {
  return <BaseSelect.Root value={value} disabled={disabled} items={options} onValueChange={(next) => {
    if (typeof next === "string") onValueChange(next);
  }}>
    <BaseSelect.Trigger {...triggerProps} className={cx(styles.selectTrigger, className)} aria-label={label}>
      <BaseSelect.Value />
      <BaseSelect.Icon className={styles.selectIcon}>⌄</BaseSelect.Icon>
    </BaseSelect.Trigger>
    <BaseSelect.Portal>
      <BaseSelect.Positioner className={styles.selectPositioner} sideOffset={6} alignItemWithTrigger={false}>
        <BaseSelect.Popup className={styles.selectPopup}>
          <BaseSelect.List className={styles.selectList}>
            {options.map((option) => <BaseSelect.Item className={styles.selectItem} key={option.value} value={option.value} disabled={option.disabled}>
              <BaseSelect.ItemIndicator className={styles.selectIndicator}>✓</BaseSelect.ItemIndicator>
              <BaseSelect.ItemText>{option.label}</BaseSelect.ItemText>
            </BaseSelect.Item>)}
          </BaseSelect.List>
        </BaseSelect.Popup>
      </BaseSelect.Positioner>
    </BaseSelect.Portal>
  </BaseSelect.Root>;
}
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...props }, ref) => <textarea ref={ref} className={cx(styles.control, styles.textarea, className)} {...props} />);
Textarea.displayName = "Textarea";

export function Field({ label, htmlFor, hint, error, children, className }: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string;
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-errormessage"?: string; "aria-invalid"?: boolean | "false" | "true" }>;
  className?: string;
}) {
  const hintId = `${htmlFor}-hint`;
  const errorId = `${htmlFor}-error`;
  const describedBy = [children.props["aria-describedby"], hint && hintId].filter(Boolean).join(" ") || undefined;
  const control = cloneElement(children, {
    id: children.props.id ?? htmlFor,
    "aria-describedby": describedBy,
    "aria-errormessage": error ? errorId : children.props["aria-errormessage"],
    "aria-invalid": error ? true : children.props["aria-invalid"],
  });
  return <div className={cx(styles.field, className)}>
    <label htmlFor={htmlFor}>{label}</label>
    {control}
    {hint && <span id={hintId} className={styles.fieldMessage}>{hint}</span>}
    {error && <span id={errorId} className={cx(styles.fieldMessage, styles.fieldError)}>{error}</span>}
  </div>;
}

export function Switch({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <label className={styles.switchRow}><BaseSwitch.Root className={styles.switch} checked={checked} disabled={disabled} onCheckedChange={onCheckedChange}><BaseSwitch.Thumb className={styles.switchThumb} /></BaseSwitch.Root><span>{label}</span></label>;
}

export function Checkbox({ checked, onCheckedChange, label, disabled }: { checked: boolean; onCheckedChange: (checked: boolean) => void; label: string; disabled?: boolean }) {
  return <label className={styles.checkboxRow}><BaseCheckbox.Root className={styles.checkbox} checked={checked} disabled={disabled} onCheckedChange={(value) => onCheckedChange(value === true)}><BaseCheckbox.Indicator>✓</BaseCheckbox.Indicator></BaseCheckbox.Root><span>{label}</span></label>;
}

export function Badge({ tone = "neutral", children, className }: { tone?: "neutral" | "info" | "success" | "warning" | "danger"; children: ReactNode; className?: string }) {
  return <span className={cx(styles.badge, styles[`tone-${tone}`], className)}>{children}</span>;
}

export function StatusDot({ tone = "neutral", label }: { tone?: "neutral" | "info" | "success" | "warning" | "danger"; label?: string }) {
  return <span className={cx(styles.statusDot, styles[`tone-${tone}`])} aria-label={label} role={label ? "img" : undefined} />;
}

export function Skeleton({ lines = 3, label = "Loading" }: { lines?: number; label?: string }) {
  return <div className={styles.skeleton} role="status" aria-label={label}>{Array.from({ length: lines }, (_, index) => <span key={index} />)}</div>;
}

export function EmptyState({ title, description, action, compact = false }: { title: string; description: string; action?: ReactNode; compact?: boolean }) {
  return <div className={cx(styles.state, compact && styles.compact)}><span className={styles.stateGlyph} aria-hidden="true">◇</span><strong>{title}</strong><p>{description}</p>{action}</div>;
}

export function ErrorState({ title, description, action, details }: { title: string; description: string; action?: ReactNode; details?: string }) {
  const { t } = useI18n();
  return <div className={cx(styles.state, styles.errorState)} role="alert"><span className={styles.stateGlyph} aria-hidden="true">!</span><strong>{title}</strong><p>{description}</p>{details && <details><summary>{t("common.details")}</summary><pre>{details}</pre></details>}{action}</div>;
}

export function InlineNotice({ tone = "info", title, children, action }: { tone?: "info" | "success" | "warning" | "danger"; title?: string; children: ReactNode; action?: ReactNode }) {
  return <div className={cx(styles.notice, styles[`tone-${tone}`])} role={tone === "danger" ? "alert" : "status"}><div>{title && <strong>{title}</strong>}{children}</div>{action}</div>;
}

export function ConfirmDialog({ open, title, description, confirmLabel, cancelLabel, danger = false, confirmDisabled = false, children, onConfirm, onOpenChange }: { open: boolean; title: string; description: string; confirmLabel: string; cancelLabel: string; danger?: boolean; confirmDisabled?: boolean; children?: ReactNode; onConfirm: () => void; onOpenChange: (open: boolean) => void }) {
  return <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
    <AlertDialog.Portal>
      <AlertDialog.Backdrop className={styles.backdrop} />
      <AlertDialog.Viewport className={styles.dialogViewport}>
        <AlertDialog.Popup className={styles.dialog}>
          <AlertDialog.Title className={styles.dialogTitle}>{title}</AlertDialog.Title>
          <AlertDialog.Description className={styles.dialogDescription}>{description}</AlertDialog.Description>
          {children}
          <div className={styles.dialogActions}><AlertDialog.Close className={cx(styles.button, styles.default)}>{cancelLabel}</AlertDialog.Close><button disabled={confirmDisabled} className={cx(styles.button, danger ? styles.danger : styles.primary)} onClick={() => { onConfirm(); onOpenChange(false); }}>{confirmLabel}</button></div>
        </AlertDialog.Popup>
      </AlertDialog.Viewport>
    </AlertDialog.Portal>
  </AlertDialog.Root>;
}

function ToastList() {
  const { t } = useI18n();
  const { toasts } = BaseToast.useToastManager();
  return toasts.map((toast) => <BaseToast.Root key={toast.id} toast={toast} className={cx(styles.toast, toast.type && styles[`toast-${toast.type}`])}>
    <BaseToast.Content className={styles.toastContent}>
      <div><BaseToast.Title className={styles.toastTitle} /><BaseToast.Description className={styles.toastDescription} /></div>
      <BaseToast.Close className={styles.toastClose} aria-label={t("common.dismiss")}>×</BaseToast.Close>
    </BaseToast.Content>
  </BaseToast.Root>);
}

export function ToastProvider({ children, timeout = 5_000 }: { children: ReactNode; timeout?: number }) {
  return <BaseToast.Provider timeout={timeout}>
    {children}
    <BaseToast.Portal><BaseToast.Viewport className={styles.toastViewport}><ToastList /></BaseToast.Viewport></BaseToast.Portal>
  </BaseToast.Provider>;
}

export const useToast = BaseToast.useToastManager;

export function VisuallyHidden({ children, ...props }: HTMLAttributes<HTMLSpanElement>) {
  return <span className={styles.visuallyHidden} {...props}>{children}</span>;
}
