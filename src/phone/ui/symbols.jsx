// Palm's own glyphs for the symbols the iPhone app shows most, drawn to the
// same size, weight and placement as there (measured from the app's own
// screenshots), so the web app reads the same. Named like the Swift code's
// systemName, so a port reads line for line. Everything else uses lucide.
import React from "react";

// A four-pointed sparkle with concave sides, centred on cx, cy.
const star = (cx, cy, rx, ry) => {
  const p = (x, y) => `${+(cx + x * rx).toFixed(3)} ${+(cy + y * ry).toFixed(3)}`;
  return `M${p(0, -1)}C${p(0.15, -0.36)} ${p(0.36, -0.15)} ${p(1, 0)}C${p(0.36, 0.15)} ${p(0.15, 0.36)} ${p(0, 1)}C${p(-0.15, 0.36)} ${p(-0.36, 0.15)} ${p(-1, 0)}C${p(-0.36, -0.15)} ${p(-0.15, -0.36)} ${p(0, -1)}Z`;
};

// Each glyph: its box in points at a reference text size (pt0), and its
// shapes in that box, stroked or filled with currentColor.
const GLYPHS = {
  "chevron.right": {
    pt0: 13,
    w: 8,
    h: 11.33,
    draw: () => <polyline points="1.645,0.975 6.355,5.665 1.645,10.355" fill="none" strokeWidth="1.95" />,
  },
  "chevron.left": {
    pt0: 13,
    w: 8,
    h: 11.33,
    draw: () => <polyline points="6.355,0.975 1.645,5.665 6.355,10.355" fill="none" strokeWidth="1.95" />,
  },
  // The back button's chevron (a 44 pt glass button in the title bar).
  "chevron.backward": {
    pt0: 17,
    w: 11,
    h: 19,
    draw: () => <polyline points="9.85,1.15 1.15,9.5 9.85,17.85" fill="none" strokeWidth="2.3" />,
  },
  "chevron.down": {
    pt0: 13,
    w: 11.33,
    h: 8,
    draw: () => <polyline points="0.975,1.645 5.665,6.355 10.355,1.645" fill="none" strokeWidth="1.95" />,
  },
  "arrow.clockwise": {
    pt0: 17,
    w: 19,
    h: 23.33,
    draw: () => (
      <>
        <path d="M16.97 9.52 A8.625 8.625 0 1 1 8.75 5.24" fill="none" strokeWidth="1.75" />
        <polyline points="8.4,0.875 12.2,5.2 8.4,9.5" fill="none" strokeWidth="1.75" />
      </>
    ),
  },
  magnifyingglass: {
    pt0: 17,
    w: 16.33,
    h: 16.33,
    draw: () => (
      <>
        <circle cx="6.8" cy="6.8" r="5.9" fill="none" strokeWidth="1.8" />
        <line x1="11.2" y1="11.2" x2="15.43" y2="15.43" strokeWidth="1.8" />
      </>
    ),
  },
  desktopcomputer: {
    pt0: 22,
    w: 25.67,
    h: 21.67,
    draw: () => (
      <g stroke="none">
        <path
          fillRule="evenodd"
          fill="currentColor"
          d="M1.6 0h22.47a1.6 1.6 0 0 1 1.6 1.6v14.1a1.6 1.6 0 0 1-1.6 1.6H1.6A1.6 1.6 0 0 1 0 15.7V1.6A1.6 1.6 0 0 1 1.6 0ZM1.85 1.6h21.97a.5 .5 0 0 1 .5.5v10a.5 .5 0 0 1-.5.5H1.85a.5 .5 0 0 1-.5-.5v-10a.5 .5 0 0 1 .5-.5Z"
        />
        <rect x="1.35" y="1.6" width="22.97" height="11" rx="0.5" fill="currentColor" opacity="0.25" />
        <rect x="10" y="17" width="5.67" height="3" fill="currentColor" />
        <rect x="8.4" y="19.6" width="8.87" height="2.07" rx="1" fill="currentColor" />
      </g>
    ),
  },
  macwindow: {
    pt0: 17,
    w: 19.67,
    h: 15.33,
    draw: () => (
      <>
        <rect x="0.7" y="0.7" width="18.27" height="13.93" rx="3" fill="none" strokeWidth="1.4" />
        <g stroke="none" fill="currentColor">
          <circle cx="3.2" cy="3.7" r="0.75" />
          <circle cx="5.87" cy="3.7" r="0.75" />
          <circle cx="8.53" cy="3.7" r="0.75" />
        </g>
      </>
    ),
  },
};

// The tab bar's five (23 pt; the tab bar shows folder filled).
GLYPHS.sparkles = {
  pt0: 23,
  w: 21,
  h: 26,
  draw: () => <path stroke="none" fill="currentColor" d={star(12.05, 17, 8.65, 8.7) + star(4.4, 8.8, 4, 3.6) + star(10, 2.6, 2.4, 2.5)} />,
};
GLYPHS["chevron.left.forwardslash.chevron.right"] = {
  pt0: 23,
  w: 32,
  h: 21.7,
  draw: () => (
    <g fill="none" strokeWidth="2">
      <polyline points="8.6,4 1.4,10.7 8.6,17.4" />
      <line x1="19.4" y1="1.1" x2="12.6" y2="20.6" />
      <polyline points="23.4,4 30.6,10.7 23.4,17.4" />
    </g>
  ),
};
GLYPHS["folder.fill"] = {
  pt0: 23,
  w: 25.6,
  h: 21,
  draw: () => (
    <path
      stroke="none"
      fill="currentColor"
      fillRule="evenodd"
      d="M2.4 0.2H7.6C8.6 0.2 9.2 0.6 9.9 1.3L11.2 2.6H23.2A2.4 2.4 0 0 1 25.6 5V18.6A2.4 2.4 0 0 1 23.2 21H2.4A2.4 2.4 0 0 1 0 18.6V2.6A2.4 2.4 0 0 1 2.4 0.2ZM2.6 4.9H23V6.7H2.6Z"
    />
  ),
};
GLYPHS.ellipsis = {
  pt0: 23,
  w: 21,
  h: 4.3,
  draw: () => (
    <g stroke="none" fill="currentColor">
      <circle cx="2.15" cy="2.15" r="2.15" />
      <circle cx="10.5" cy="2.15" r="2.15" />
      <circle cx="18.85" cy="2.15" r="2.15" />
    </g>
  ),
};

export const hasSymbol = (name) => Object.hasOwn(GLYPHS, name);

/** An SF-style glyph at a text size in points (the Swift code's .font). */
export function Symbol({ name, pt, className, style, label }) {
  const glyph = GLYPHS[name];
  if (!glyph) throw new Error(`No glyph for ${name}`);
  const scale = (pt ?? glyph.pt0) / glyph.pt0;
  return (
    <svg
      className={className}
      style={style}
      width={+(glyph.w * scale).toFixed(3)}
      height={+(glyph.h * scale).toFixed(3)}
      viewBox={`0 0 ${glyph.w} ${glyph.h}`}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    >
      {glyph.draw()}
    </svg>
  );
}
