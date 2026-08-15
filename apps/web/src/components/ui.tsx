import clsx from "clsx";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { X } from "lucide-react";

export function Button({
  className,
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-[#0f8b8d] text-white hover:bg-[#0c7476]",
        variant === "secondary" && "border border-[#d4dad7] bg-white text-[#243033] hover:bg-[#f6f8f7]",
        variant === "danger" && "bg-[#c84630] text-white hover:bg-[#a93625]",
        variant === "ghost" && "text-[#344145] hover:bg-[#edf1ef]",
        className
      )}
    />
  );
}

export function IconButton({
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...props}
      className={clsx(
        "inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-transparent text-[#546267] transition hover:border-[#d8dfdc] hover:bg-white disabled:cursor-not-allowed disabled:opacity-40",
        className
      )}
    />
  );
}

export function TextInput({
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={clsx(
        "h-10 w-full rounded-md border border-[#d4dad7] bg-white px-3 text-sm text-[#1e2528] placeholder:text-[#7a878a]",
        className
      )}
    />
  );
}

export function Modal({
  title,
  children,
  onClose
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#1b2224]/40 p-4">
      <section className="w-full max-w-lg rounded-lg border border-[#d7ddda] bg-white shadow-soft">
        <header className="flex items-center justify-between border-b border-[#e5e9e7] px-5 py-4">
          <h2 className="text-base font-semibold text-[#1f2a2d]">{title}</h2>
          <IconButton onClick={onClose} title="Close">
            <X size={18} />
          </IconButton>
        </header>
        <div className="px-5 py-5">{children}</div>
      </section>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-[#cfd7d3] bg-white/70 p-8 text-center">
      <p className="text-base font-semibold text-[#1f2a2d]">{title}</p>
      {detail ? <p className="mt-2 max-w-md text-sm text-[#667478]">{detail}</p> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function Notice({
  tone = "info",
  children
}: {
  tone?: "info" | "success" | "danger";
  children: ReactNode;
}) {
  return (
    <div
      className={clsx(
        "rounded-md border px-3 py-2 text-sm",
        tone === "info" && "border-[#cbd9db] bg-[#eef7f7] text-[#245154]",
        tone === "success" && "border-[#cdddbb] bg-[#f2f8ec] text-[#385623]",
        tone === "danger" && "border-[#efc8bd] bg-[#fff1ed] text-[#8b321f]"
      )}
    >
      {children}
    </div>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-current border-r-transparent" />
  );
}
