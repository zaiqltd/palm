// The iPhone app's building blocks, for the web: title bars with glass
// buttons, inset grouped lists, sheets, pull-down menus, switches, dialogs,
// toasts. Each mirrors a SwiftUI control Palm uses (see PalmStyle.swift).
import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, ChevronsUpDown, CircleAlert, CircleCheck, X } from "lucide-react";
import { handShapes } from "../../brand.js";
import { Symbol } from "./symbols.jsx";

export { Symbol };

export const cx = (...names) => names.filter(Boolean).join(" ");

/** iOS never leaves one word alone on a wrapped text's last line (its
 * "push out" line breaking): the last two words stay together. */
export const keepLastWords = (text) => (typeof text === "string" ? text.replace(/ (\S+)\s*$/, "\u00a0$1") : text);

/** An icon at SF Symbol sizes: `size` in points, drawn at a weight close to SF's. */
export function Icon({ as: Component, size = 20, weight = 2, className, ...props }) {
  return <Component className={cx("icon", className)} size={size} strokeWidth={weight} aria-hidden="true" {...props} />;
}

export function Spinner({ large = false, color = "currentColor" }) {
  const n = 8;
  return (
    <svg className={cx("spinner", large && "large")} viewBox="0 0 40 40" aria-label="Loading" role="img">
      {Array.from({ length: n }, (_, i) => (
        <rect key={i} x="18.2" y="3" width="3.6" height="10" rx="1.8" fill={color} opacity={0.2 + (0.8 * i) / (n - 1)} transform={`rotate(${(i * 360) / n} 20 20)`} />
      ))}
    </svg>
  );
}

export function PalmMark({ size = 40 }) {
  return (
    <span className="palm-mark" style={{ width: size, height: size, borderRadius: size * 0.28 }} aria-hidden="true">
      <svg viewBox="0 0 1024 1024" dangerouslySetInnerHTML={{ __html: handShapes }} />
    </span>
  );
}

/** A Mac app's icon (a PNG data URL from the Mac), or its first letter. */
export function AppIcon({ name, icon, size = 48 }) {
  if (icon) return <img className="app-icon" src={icon} alt="" width={size} height={size} style={{ width: size, height: size }} />;
  return (
    <span className="app-icon letter" style={{ width: size, height: size, borderRadius: size * 0.24, fontSize: size * 0.48 }} aria-hidden="true">
      {String(name || "").slice(0, 1)}
    </span>
  );
}

// ---- Title bars ----

/** A round 44 pt glass button with one glyph: `symbol` (Palm's own, at `pt`) or a lucide `icon`. */
export function GlassButton({ icon, symbol, pt, label, onClick, disabled, id, size = 20, children, className, ...props }) {
  return (
    <button type="button" className={cx("glass-button glass", className)} onClick={onClick} disabled={disabled} aria-label={label} data-id={id} {...props}>
      {symbol ? <Symbol name={symbol} pt={pt} /> : icon ? <Icon as={icon} size={size} /> : children}
    </button>
  );
}

export function GlassTextButton({ children, onClick, disabled, prominent, id, ...props }) {
  return (
    <button type="button" className={cx("glass-text-button", prominent ? "prominent" : "glass")} onClick={onClick} disabled={disabled} data-id={id} {...props}>
      {children}
    </button>
  );
}

/** A top-level screen's bar: a large title with its subtitle, buttons on the same row. */
export function NavBar({ title, subtitle, trailing, leading, inline = false, titleMenu, children }) {
  return (
    <header className={cx("navbar", inline && "inline")}>
      <div className="navbar-row">
        {leading && <div className="navbar-leading">{leading}</div>}
        <div className="title-block">
          {inline ? (
            titleMenu ? (
              <button type="button" className="inline-title inline-title-button" onClick={titleMenu} aria-label={`${title}, choose computer`}>
                {title}
                <span className="title-chevron">
                  <Icon as={ChevronDown} size={13} weight={2.6} />
                </span>
              </button>
            ) : (
              <div className="inline-title" role="heading" aria-level={1}>
                {title}
              </div>
            )
          ) : (
            <div className="large-title" role="heading" aria-level={1}>
              {title}
            </div>
          )}
          {subtitle && <div className="subtitle">{subtitle}</div>}
        </div>
        {trailing && <div className="navbar-trailing">{trailing}</div>}
      </div>
      {children}
    </header>
  );
}

export function BackButton({ onClick, label = "Back" }) {
  return <GlassButton symbol="chevron.backward" label={label} onClick={onClick} id="nav.back" className="back-button" />;
}

export function SearchField({ value, onChange, placeholder, id, autoFocus }) {
  return (
    <label className="search-field">
      <Symbol name="magnifyingglass" className="search-glyph" />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        data-id={id}
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        enterKeyHint="search"
      />
      {value && (
        <button type="button" className="clear" onClick={() => onChange("")} aria-label="Clear text">
          <Icon as={X} size={13} weight={3} />
        </button>
      )}
    </label>
  );
}

// ---- Lists ----

export function List({ children, className }) {
  return <div className={cx("list", className)}>{children}</div>;
}

export function Section({ header, footer, children, clear = false, id }) {
  return (
    <section className="section" data-id={id}>
      {header && <div className="section-header">{header}</div>}
      <div className={cx("section-body", clear && "clear")}>{children}</div>
      {footer && <div className="section-footer">{footer}</div>}
    </section>
  );
}

/** One list row: optional leading icon, title and detail, a trailing value, a
 * chevron. `inset`: where the separator under it starts, in points from the
 * card's edge (SwiftUI starts it where the row's first text starts). */
export function Row({ icon, leading, title, titleClassName, detail, value, chevron, onClick, disabled, id, label, trailing, className, destructive, accent, children, style, inset }) {
  if (inset === undefined) inset = icon ? 62 : leading ? undefined : 20;
  if (inset !== undefined) style = { ...style, "--separator-inset": `${inset}px` };
  const content = (
    <>
      {leading}
      {icon && (
        <span className="row-icon">
          <Icon as={icon} size={21} weight={1.9} />
        </span>
      )}
      {(title || detail) && (
        <span className="row-main">
          {title && <span className={cx("row-title", titleClassName)}>{keepLastWords(title)}</span>}
          {detail && <span className="row-detail">{keepLastWords(detail)}</span>}
        </span>
      )}
      {children}
      {value !== undefined && value !== null && <span className="row-value">{value}</span>}
      {trailing}
      {/* chevron="spaced": the Swift row's Spacer(minLength: 8) before it, inside an HStack(spacing: 14). */}
      {chevron && <Symbol name="chevron.right" pt={13} className={cx("chevron", chevron === "spaced" && "spaced")} />}
    </>
  );
  const classes = cx("row", destructive && "destructive", accent && "accent", className);
  if (onClick)
    return (
      <button type="button" className={classes} onClick={onClick} disabled={disabled} data-id={id} aria-label={label} style={style}>
        {content}
      </button>
    );
  return (
    <div className={classes} data-id={id} aria-label={label} style={style}>
      {content}
    </div>
  );
}

export function Toggle({ checked, onChange, disabled, label, id }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      data-id={id}
      disabled={disabled}
      className={cx("switch", checked && "on")}
      onClick={() => onChange(!checked)}
    />
  );
}

/** A labelled switch row (SwiftUI Toggle in a Form). */
export function ToggleRow({ title, detail, checked, onChange, disabled, id }) {
  return (
    <Row title={title} detail={detail} id={id} trailing={<Toggle checked={checked} onChange={onChange} disabled={disabled} label={title} id={id && id + ".switch"} />} />
  );
}

/** A menu-style picker row: the value with ⌃⌄, choices in a pull-down menu. */
export function PickerRow({ title, value, options, onChange, disabled, id }) {
  const menu = useMenu();
  const current = options.find((o) => o.value === value);
  return (
    <Row
      title={title}
      id={id}
      disabled={disabled}
      onClick={(e) =>
        menu.open(
          e.currentTarget,
          options.map((o) => ({ label: o.label, checked: o.value === value, action: () => onChange(o.value) })),
          { align: "right" },
        )
      }
      trailing={
        <span className="row-value" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          {current?.label}
          <Icon as={ChevronsUpDown} size={14} weight={2.2} />
        </span>
      }
    />
  );
}

export function PrimaryButton({ children, onClick, disabled, id, type = "button" }) {
  return (
    <button type={type} className="primary-button" onClick={onClick} disabled={disabled} data-id={id}>
      {children}
    </button>
  );
}

export function SecondaryButton({ children, onClick, disabled, id, type = "button" }) {
  return (
    <button type={type} className="secondary-button" onClick={onClick} disabled={disabled} data-id={id}>
      {children}
    </button>
  );
}

export function Notice({ icon = CircleAlert, children, warning = false, id }) {
  return (
    <div className={cx("notice", warning && "warning")} data-id={id} role={warning ? "alert" : undefined}>
      <Icon as={icon} size={17} />
      <span>{children}</span>
    </div>
  );
}

export function ContentUnavailable({ icon, title, description, children }) {
  return (
    <div className="unavailable">
      {icon && <Icon as={icon} size={44} weight={1.6} />}
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {children}
    </div>
  );
}

// ---- Overlays: one layer for menus, sheets, dialogs and toasts ----

const OverlayContext = createContext(null);

export function OverlayHost({ children }) {
  const [menu, setMenu] = useState(null);
  const [dialog, setDialog] = useState(null);
  const [toasts, setToasts] = useState([]);
  const toast = useCallback((message, { warning = false, id } = {}) => {
    if (!message) return;
    const key = crypto.randomUUID();
    setToasts((list) => [...list.filter((t) => t.message !== message), { key, message, warning, id }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.key !== key)), warning ? 8000 : 4000);
  }, []);
  const value = { setMenu, setDialog, toast };
  return (
    <OverlayContext.Provider value={value}>
      {children}
      {toasts.length > 0 &&
        createPortal(
          <div className="toast-layer" style={{ top: "calc(var(--sat) + 68px)" }}>
            {toasts.map((t) => (
              <div key={t.key} className="toast glass" data-id={t.warning ? "toast.warning" : "toast.notice"} role="status">
                <Icon as={t.warning ? CircleAlert : CircleCheck} size={18} style={{ color: t.warning ? "var(--orange)" : "var(--accent)" }} />
                <span className="toast-text">{t.message}</span>
                <button type="button" className="dismiss" aria-label="Dismiss" onClick={() => setToasts((l) => l.filter((x) => x.key !== t.key))}>
                  <Icon as={X} size={14} weight={2.6} />
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
      {menu && <MenuView {...menu} close={() => setMenu(null)} />}
      {dialog && <DialogView {...dialog} close={() => setDialog(null)} />}
    </OverlayContext.Provider>
  );
}

export const useToast = () => useContext(OverlayContext).toast;

/** Pull-down menus: open(anchorElement, items, { align }). Items: { label, icon, checked, destructive, action } or "divider". */
export function useMenu() {
  const { setMenu } = useContext(OverlayContext);
  return {
    open(anchor, items, options = {}) {
      const rect = anchor.getBoundingClientRect();
      setMenu({ rect, items, ...options });
    },
    close: () => setMenu(null),
  };
}

function MenuView({ rect, items, align = "right", up = false, close }) {
  const ref = useRef();
  const [position, setPosition] = useState({ opacity: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    const width = el.offsetWidth;
    const height = el.offsetHeight;
    let left = align === "left" ? rect.left : align === "center" ? rect.left + rect.width / 2 - width / 2 : rect.right - width;
    left = Math.max(12, Math.min(innerWidth - width - 12, left));
    let top = up ? rect.top - height - 8 : rect.bottom + 8;
    if (top + height > innerHeight - 12) top = Math.max(12, rect.top - height - 8);
    setPosition({ left, top, transformOrigin: `${align === "left" ? "left" : "right"} ${up ? "bottom" : "top"}` });
  }, [rect, align, up]);
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && close();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [close]);
  return createPortal(
    <>
      <div className="menu-shade" onClick={close} onTouchStart={(e) => e.target === e.currentTarget && e.preventDefault()} />
      <div className="menu glass" ref={ref} style={position} role="menu">
        {items.map((item, i) =>
          item === "divider" ? (
            <div key={i} className="menu-divider" role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role="menuitem"
              className={cx(item.destructive && "destructive")}
              data-id={item.id}
              disabled={item.disabled}
              onClick={() => {
                close();
                item.action?.();
              }}
            >
              {item.checked !== undefined && <span className="menu-check">{item.checked && <Icon as={Check} size={17} weight={2.6} />}</span>}
              <span style={{ flex: 1 }}>{item.label}</span>
              {item.icon && <Icon as={item.icon} size={19} />}
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  );
}

/** Alerts and confirmation dialogs: confirm({ title, message, confirmLabel, destructive }) → Promise<boolean>. */
export function useDialog() {
  const { setDialog } = useContext(OverlayContext);
  return {
    confirm: (options) => new Promise((resolve) => setDialog({ ...options, kind: "confirm", resolve })),
    prompt: (options) => new Promise((resolve) => setDialog({ ...options, kind: "prompt", resolve })),
  };
}

/**
 * prompt({ title, value, placeholder, secure }) resolves to the text or null;
 * prompt({ title, fields: [{ value, placeholder, id }] }) to an array or null.
 */
function DialogView({ kind, title, message, confirmLabel = "OK", cancelLabel = "Cancel", destructive, value = "", placeholder, secure, fields, resolve, close }) {
  const inputs = fields ?? [{ value, placeholder, secure }];
  const [texts, setTexts] = useState(() => inputs.map((f) => f.value ?? ""));
  const finish = (result) => {
    close();
    resolve(result);
  };
  const answer = () => (fields ? texts : texts[0]);
  return createPortal(
    <div className="dialog-shade" onClick={(e) => e.target === e.currentTarget && finish(kind === "prompt" ? null : false)}>
      <div className="dialog glass" role="alertdialog" aria-label={title}>
        <h2>{title}</h2>
        {message && <p>{message}</p>}
        {kind === "prompt" &&
          inputs.map((f, i) => (
            <input
              key={i}
              autoFocus={i === 0}
              type={f.secure ? "password" : "text"}
              value={texts[i]}
              placeholder={f.placeholder}
              data-id={f.id}
              autoCapitalize={f.secure || f.plain ? "none" : undefined}
              autoCorrect={f.secure || f.plain ? "off" : undefined}
              onChange={(e) => setTexts((t) => t.map((v, j) => (j === i ? e.target.value : v)))}
              onKeyDown={(e) => e.key === "Enter" && i === inputs.length - 1 && finish(answer())}
              aria-label={f.placeholder || title}
            />
          ))}
        <div className={cx("dialog-buttons", kind === "prompt" && "pair")}>
          <button type="button" className={destructive ? "destructive" : "default"} data-id="dialog.confirm" onClick={() => finish(kind === "prompt" ? answer() : true)}>
            {confirmLabel}
          </button>
          <button type="button" data-id="dialog.cancel" onClick={() => finish(kind === "prompt" ? null : false)}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A sheet (SwiftUI .sheet with detents): slides up, drags down to close.
 * detent "medium" starts at half height and can be dragged up to "large".
 */
export function Sheet({ title, onClose, leading, trailing, children, detent = "large", passthrough = false, floating = false, id }) {
  const ref = useRef();
  const [height, setHeight] = useState(detent === "medium" ? "52%" : "calc(100% - var(--sat) - 10px)");
  const drag = useRef(null);
  const onPointerDown = (e) => {
    if (e.target.closest("button,input,textarea,a,.sheet-body")) return;
    drag.current = { y: e.clientY, start: ref.current.getBoundingClientRect().height };
    ref.current.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const delta = e.clientY - drag.current.y;
    ref.current.style.transform = delta > 0 ? `translateY(${delta}px)` : "";
    if (delta < -40 && detent === "medium") setHeight("calc(100% - var(--sat) - 10px)");
  };
  const onPointerUp = (e) => {
    if (!drag.current) return;
    const delta = e.clientY - drag.current.y;
    drag.current = null;
    ref.current.style.transform = "";
    if (delta > 110) onClose();
  };
  useEffect(() => {
    const onKey = (e) => e.key === "Escape" && onClose();
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  return createPortal(
    <>
      <div className={cx("sheet-shade", passthrough && "passthrough")} onClick={onClose} />
      <div
        ref={ref}
        className={cx("sheet", floating && "floating")}
        style={{ height }}
        role="dialog"
        aria-label={title}
        data-id={id}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="grabber" />
        {(title || leading || trailing) && (
          <div className="sheet-header">
            <div className="sheet-leading">{leading}</div>
            {title && <div className="sheet-title">{title}</div>}
            <div className="sheet-trailing">{trailing}</div>
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

/** "Done" in a sheet's corner (SwiftUI confirmationAction). */
export function DoneButton({ onClick, label = "Done", id = "sheet.done", disabled }) {
  return (
    <GlassTextButton onClick={onClick} id={id} disabled={disabled}>
      {label}
    </GlassTextButton>
  );
}

/** Palm hides itself in the app switcher (PalmPrivacyShield). */
export function PrivacyShield() {
  const [hidden, setHidden] = useState(document.visibilityState === "hidden");
  useEffect(() => {
    const onChange = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", onChange);
    addEventListener("pagehide", () => setHidden(true));
    addEventListener("pageshow", () => setHidden(false));
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);
  if (!hidden) return null;
  return (
    <div className="privacy-shield" aria-label="Palm privacy screen">
      <div className="inner">
        <PalmMark size={58} />
        Palm
      </div>
    </div>
  );
}

/** A value that follows a store, re-rendering the caller. */
export function useInterval(callback, ms, active = true) {
  const saved = useRef(callback);
  saved.current = callback;
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms, active]);
}
