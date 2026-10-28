import type { ButtonHTMLAttributes } from "react";
import "./ui.css";

export type ButtonVariant = "default" | "primary" | "danger";

export function Button({
  variant = "default",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant }) {
  return (
    <button
      type={type}
      className={["btn", `btn-${variant}`, className].filter(Boolean).join(" ")}
      {...props}
    />
  );
}
