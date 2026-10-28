import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ExtensionUiRequest, ExtensionUiResponse } from "../../../shared/protocol.ts";
import { api } from "../api/client.ts";
import { errorText } from "../app/errors.ts";
import { Button } from "../ui/button.tsx";
import { Modal } from "../ui/modal.tsx";
import { toast } from "../ui/toasts.tsx";
import "./dialogs.css";

export interface ExtensionDialogProps {
  sessionId: string;
  request: ExtensionUiRequest;
  /** Called before the API call so the parent can move on to the next request */
  onAnswered?: (id: string) => void;
}

/** Modal for one extension UI request (select / confirm / input / editor). */
export function ExtensionDialog({ sessionId, request, onAnswered }: ExtensionDialogProps) {
  const [hidden, setHidden] = useState(false);
  const [active, setActive] = useState(0);
  const [value, setValue] = useState(() => (request.method === "editor" ? request.prefill ?? "" : ""));
  const [remaining, setRemaining] = useState(() =>
    request.timeout === undefined ? 0 : Math.ceil(request.timeout / 1000),
  );
  const answeredRef = useRef(false);
  const startedRef = useRef(Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const timeout = request.timeout;
    if (timeout === undefined) return;
    const tick = () => {
      const elapsed = Date.now() - startedRef.current;
      setRemaining(Math.max(0, Math.ceil((timeout - elapsed) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [request]);

  const answer = async (response: ExtensionUiResponse) => {
    if (answeredRef.current) return;
    answeredRef.current = true;
    setHidden(true);
    onAnswered?.(request.id);
    try {
      await api.respondUi(sessionId, response);
    } catch (error) {
      toast(errorText(error), "error");
    }
  };

  if (hidden) return null;

  const cancel = () => void answer({ id: request.id, cancelled: true });
  const countdown =
    request.timeout === undefined ? undefined : <span className="dialog-countdown">{remaining} 秒</span>;

  const onSelectKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (request.method !== "select") return;
    const count = request.options.length;
    if (count === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = event.key === "ArrowDown" ? (active + 1) % count : (active - 1 + count) % count;
      setActive(next);
      listRef.current?.querySelectorAll<HTMLButtonElement>("button")[next]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter") {
      event.preventDefault();
      const option = request.options[active];
      if (option !== undefined) void answer({ id: request.id, value: option });
    }
  };

  if (request.method === "select") {
    return (
      <Modal
        title={request.title}
        headExtra={countdown}
        onClose={cancel}
        footer={<Button onClick={cancel}>取消</Button>}
      >
        <div className="ext-select" role="listbox" ref={listRef} tabIndex={0} onKeyDown={onSelectKeyDown}>
          {request.options.map((option, index) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={index === active}
              className={index === active ? "ext-option active" : "ext-option"}
              onMouseEnter={() => setActive(index)}
              onClick={() => void answer({ id: request.id, value: option })}
            >
              {option}
            </button>
          ))}
        </div>
      </Modal>
    );
  }

  if (request.method === "confirm") {
    return (
      <Modal
        title={request.title}
        headExtra={countdown}
        onClose={cancel}
        footer={
          <>
            <Button onClick={() => void answer({ id: request.id, confirmed: false })}>取消</Button>
            <Button variant="primary" onClick={() => void answer({ id: request.id, confirmed: true })}>
              确认
            </Button>
          </>
        }
      >
        <p className="dialog-message">{request.message}</p>
      </Modal>
    );
  }

  if (request.method === "input") {
    const submit = () => void answer({ id: request.id, value });
    return (
      <Modal
        title={request.title}
        headExtra={countdown}
        onClose={cancel}
        footer={
          <>
            <Button onClick={cancel}>取消</Button>
            <Button variant="primary" onClick={submit}>
              确定
            </Button>
          </>
        }
      >
        <input
          className="text-input"
          value={value}
          placeholder={request.placeholder}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
        />
      </Modal>
    );
  }

  const submitEditor = () => void answer({ id: request.id, value });
  return (
    <Modal
      title={request.title}
      headExtra={countdown}
      onClose={cancel}
      footer={
        <>
          <Button onClick={cancel}>取消</Button>
          <Button variant="primary" onClick={submitEditor}>
            确定
          </Button>
        </>
      }
    >
      <textarea
        className="ext-editor"
        rows={8}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submitEditor();
          }
        }}
      />
      <p className="dialog-hint">Ctrl/⌘ + Enter 提交</p>
    </Modal>
  );
}
