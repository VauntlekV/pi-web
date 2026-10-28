/** Small shared pieces of the transcript: copy button and image thumbnails. */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { ImageContent } from "../../../shared/protocol.ts";

export function CopyButton({
  text,
  label = "复制",
  className,
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      setCopied(fallbackCopy(text));
      return;
    }
    clipboard
      .writeText(text)
      .then(() => setCopied(true))
      .catch(() => setCopied(fallbackCopy(text)));
  };

  return (
    <button
      type="button"
      className={`copy-btn${className ? ` ${className}` : ""}`}
      onClick={copy}
      title={copied ? "已复制" : label}
      aria-label={copied ? "已复制" : label}
    >
      {copied ? <Check size={14} strokeWidth={1.75} aria-hidden /> : <Copy size={14} strokeWidth={1.75} aria-hidden />}
    </button>
  );
}

/** A message/result image; clicks open the original in a new tab (via a blob URL). */
export function ImageThumb({ image, alt }: { image: ImageContent; alt: string }) {
  return (
    <button
      type="button"
      className="image-thumb"
      onClick={() => openImage(image)}
      title="在新标签页打开原图"
      aria-label={alt}
    >
      <img src={`data:${image.mimeType};base64,${image.data}`} alt={alt} />
    </button>
  );
}

/** Clipboard API needs a secure context; LAN http deployments fall back to execCommand. */
function fallbackCopy(text: string): boolean {
  try {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

function openImage(image: ImageContent) {
  try {
    const binary = atob(image.data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: image.mimeType }));
    window.open(url, "_blank", "noopener,noreferrer");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch {
    // Corrupt base64: nothing sensible to open.
  }
}
