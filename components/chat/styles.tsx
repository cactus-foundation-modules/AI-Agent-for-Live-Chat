'use client'

// The look of this module's bits inside Live Chat's windows. Colour tokens
// only, so the site's theme (light or dark) carries straight through, and
// classes prefixed `aic-` so nothing here can collide with Live Chat's own or
// the site's.
//
// Two places they sit:
//   - a coloured header (the bubble's, and the chat header in the bubble):
//     colours borrowed from the header itself (currentColor), as Live Chat's
//     own Online switch does there
//   - a plain surface (the admin inbox, the visitor's chat): the surface
//     tokens
// Drawn by each component that needs it, the way Live Chat draws its own.

const CSS = `
.aic-pill{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--color-border-strong);background:var(--color-surface);color:var(--color-text);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;line-height:1.4;flex:none;cursor:pointer;font-family:inherit}
.aic-pill:disabled{opacity:.6;cursor:default}
.aic-pill .aic-dot{width:8px;height:8px;border-radius:999px;background:var(--color-text-muted)}
.aic-pill.on .aic-dot{background:var(--color-success)}
.aic-pill.aic-dark{background:transparent;border-color:currentColor;color:inherit}
.aic-pill.aic-dark .aic-dot{background:currentColor;opacity:.5}
.aic-pill.aic-dark.on .aic-dot{background:var(--color-success-bg);opacity:1}
.aic-controls{position:relative;display:inline-flex;align-items:center;gap:6px;flex:none;min-width:0}
.aic-state{display:inline-flex;align-items:center;border:1px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:1.5;white-space:nowrap;opacity:.9}
.aic-controls button.aic-act{border:1px solid currentColor;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:600;line-height:1.5;white-space:nowrap;background:transparent;color:inherit;cursor:pointer;font-family:inherit}
.aic-controls button.aic-act:disabled{opacity:.6;cursor:default}
.aic-notes{position:absolute;top:calc(100% + 6px);right:0;z-index:5;width:min(320px,80vw);max-height:280px;overflow:auto;background:var(--color-surface);color:var(--color-text);border:1px solid var(--color-border);border-radius:10px;box-shadow:var(--shadow-md);padding:10px 12px;font-size:12px;font-weight:400;text-align:left}
.aic-notes h3{margin:0 0 6px;font-size:12px;font-weight:600;color:var(--color-text)}
.aic-notes p{margin:0 0 10px;line-height:1.45}
.aic-notes p + h3{margin-top:4px}
.aic-notes ul{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:6px}
.aic-notes li{border-top:1px solid var(--color-border);padding-top:6px}
.aic-notes .aic-muted{color:var(--color-text-muted)}
.aic-notes .aic-bad{color:var(--color-error)}
.aic-basket{display:flex;flex-wrap:wrap;gap:6px;margin:2px 0 4px}
.aic-basket button,.aic-basket a{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--color-border-strong);background:var(--color-surface);color:var(--color-text);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:600;line-height:1.4;text-decoration:none;cursor:pointer;font-family:inherit}
.aic-basket button:hover,.aic-basket a:hover{border-color:var(--color-primary)}
.aic-basket button:disabled{opacity:.6;cursor:default}
.aic-basket .aic-added{display:inline-flex;align-items:center;font-size:12px;font-weight:600;color:var(--color-success)}
`

export function AiChatStyles() {
  return <style dangerouslySetInnerHTML={{ __html: CSS }} />
}
