/**
 * Model and thinking-level pickers shown at the right of the composer toolbar.
 * Both open an upward popover with a keyboard-navigable list (↑/↓/Enter/Esc).
 */
import { useEffect, useRef, useState } from "react";
import { Brain, Check, ChevronDown, Image as ImageIcon, Search } from "lucide-react";
import type { ModelInfo, ModelRef, ThinkingLevel } from "../../../shared/protocol.ts";
import { thinkingLabel } from "./lib.ts";
import { Popover } from "../ui/popover.tsx";

const ICON_STROKE = 1.75;

interface ModelPickerProps {
  models: ModelInfo[];
  model: ModelRef | undefined;
  disabled?: boolean;
  onSelect: (ref: ModelRef) => void;
  onOpen?: () => void;
}

export function ModelPicker({ models, model, disabled, onSelect, onOpen }: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const current = models.find((m) => m.provider === model?.provider && m.id === model?.id);
  const label = models.length === 0 ? "无可用模型" : (current?.name ?? model?.id ?? "选择模型");
  const showSearch = models.length > 8;

  const q = query.toLowerCase();
  const visible = q
    ? models.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.id.toLowerCase().includes(q) ||
          m.provider.toLowerCase().includes(q),
      )
    : models;

  const groups: { provider: string; items: { model: ModelInfo; index: number }[] }[] = [];
  const flat: { model: ModelInfo; index: number }[] = [];
  for (const item of visible) {
    let group = groups.find((g) => g.provider === item.provider);
    if (!group) {
      group = { provider: item.provider, items: [] };
      groups.push(group);
    }
    const entry = { model: item, index: flat.length };
    group.items.push(entry);
    flat.push(entry);
  }

  const active = flat.length === 0 ? -1 : Math.min(activeIndex, flat.length - 1);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) anchorRef.current?.focus();
  };

  const choose = (item: ModelInfo) => {
    onSelect({ provider: item.provider, id: item.id });
    close(true);
  };

  const openMenu = () => {
    onOpen?.();
    setQuery("");
    const index = models.findIndex((m) => m.provider === model?.provider && m.id === model?.id);
    setActiveIndex(index < 0 ? 0 : index);
    setOpen(true);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="composer-trigger"
        disabled={disabled || models.length === 0}
        title={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openMenu())}
      >
        <span className="composer-trigger-label">{label}</span>
        <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </button>

      {open && (
        <Popover anchor={anchorRef.current} onClose={close} className="composer-popover composer-popover-model">
          <div
            className="composer-menu"
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (flat.length === 0) return;
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex(((active < 0 ? 0 : active) + delta + flat.length) % flat.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = flat[active];
                if (item) choose(item.model);
              }
            }}
          >
            {showSearch && (
              <label className="composer-menu-search">
                <Search size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
                <input
                  data-autofocus
                  type="search"
                  value={query}
                  placeholder="搜索模型"
                  aria-label="搜索模型"
                  aria-controls="composer-model-list"
                  aria-activedescendant={active >= 0 ? `composer-model-option-${active}` : undefined}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    setActiveIndex(0);
                  }}
                />
              </label>
            )}
            <div
              ref={listRef}
              id="composer-model-list"
              className="composer-menu-list"
              role="listbox"
              aria-label="选择模型"
              tabIndex={-1}
              aria-activedescendant={active >= 0 ? `composer-model-option-${active}` : undefined}
            >
              {groups.map((group) => (
                <div key={group.provider} className="composer-menu-group" role="group" aria-label={group.provider}>
                  <div className="composer-menu-group-label">{group.provider}</div>
                  {group.items.map(({ model: item, index }) => {
                    const isCurrent = current === item;
                    return (
                      <div
                        key={`${item.provider}/${item.id}`}
                        id={`composer-model-option-${index}`}
                        data-index={index}
                        data-active={index === active}
                        role="option"
                        aria-selected={isCurrent}
                        className="composer-menu-item"
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => choose(item)}
                      >
                        <span className="composer-menu-check">
                          {isCurrent && <Check size={13} strokeWidth={2} aria-hidden="true" />}
                        </span>
                        <span className="composer-menu-name">{item.name}</span>
                        <span className="composer-menu-icons">
                          {item.vision && (
                            <span title="支持图片">
                              <ImageIcon size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                            </span>
                          )}
                          {item.reasoning && (
                            <span title="支持思考">
                              <Brain size={12} strokeWidth={ICON_STROKE} aria-hidden="true" />
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {flat.length === 0 && <div className="composer-menu-empty">无匹配模型</div>}
            </div>
          </div>
        </Popover>
      )}
    </>
  );
}

interface ThinkingPickerProps {
  level: ThinkingLevel;
  levels: ThinkingLevel[];
  disabled?: boolean;
  onSelect: (level: ThinkingLevel) => void;
  onOpen?: () => void;
}

export function ThinkingPicker({ level, levels, disabled, onSelect, onOpen }: ThinkingPickerProps) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const anchorRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const active = levels.length === 0 ? -1 : Math.min(activeIndex, levels.length - 1);

  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) anchorRef.current?.focus();
  };

  const choose = (item: ThinkingLevel) => {
    onSelect(item);
    close(true);
  };

  const openMenu = () => {
    onOpen?.();
    const index = levels.indexOf(level);
    setActiveIndex(index < 0 ? 0 : index);
    setOpen(true);
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="composer-trigger"
        disabled={disabled || levels.length <= 1}
        title={thinkingLabel(level)}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? close(false) : openMenu())}
      >
        <span className="composer-trigger-label">{thinkingLabel(level)}</span>
        <ChevronDown size={14} strokeWidth={ICON_STROKE} aria-hidden="true" />
      </button>

      {open && (
        <Popover anchor={anchorRef.current} onClose={close} className="composer-popover composer-popover-thinking">
          <div
            ref={listRef}
            className="composer-menu-list"
            role="listbox"
            aria-label="思考档位"
            tabIndex={-1}
            data-autofocus
            aria-activedescendant={active >= 0 ? `composer-thinking-option-${active}` : undefined}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                if (levels.length === 0) return;
                const delta = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex(((active < 0 ? 0 : active) + delta + levels.length) % levels.length);
              } else if (event.key === "Enter") {
                event.preventDefault();
                const item = levels[active];
                if (item) choose(item);
              }
            }}
          >
            {levels.map((item, index) => (
              <div
                key={item}
                id={`composer-thinking-option-${index}`}
                data-index={index}
                data-active={index === active}
                role="option"
                aria-selected={item === level}
                className="composer-menu-item"
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(item)}
              >
                <span className="composer-menu-check">
                  {item === level && <Check size={13} strokeWidth={2} aria-hidden="true" />}
                </span>
                <span className="composer-menu-name">{thinkingLabel(item)}</span>
              </div>
            ))}
          </div>
        </Popover>
      )}
    </>
  );
}
