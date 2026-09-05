import type { ReactNode } from 'react';

// Scoped to Crew panels: the official application's settings shell is untouched.
export function PanelStyles() {
  return <style>{`
    .dsh-crew-ui { --crew-line: rgba(128,128,128,.24); --crew-soft: rgba(128,128,128,.045); --crew-accent: #2563eb; font-size: 13px; line-height: 1.55; min-width: 0; }
    .dsh-crew-ui *, .dsh-crew-ui *::before, .dsh-crew-ui *::after { box-sizing: border-box; }
    .dsh-crew-ui .crew-panel-header { border: 1px solid var(--crew-line); border-radius: 12px; padding: 16px; background: var(--crew-soft); display: flex; flex-wrap: wrap; align-items: flex-start; gap: 12px 16px; }
    .dsh-crew-ui .crew-panel-heading { flex: 1 1 260px; min-width: 0; }
    .dsh-crew-ui .crew-eyebrow { font-size: 10.5px; letter-spacing: .055em; opacity: .65; margin-bottom: 4px; }
    .dsh-crew-ui .crew-panel-title { margin: 0; font-size: 19px; font-weight: 680; line-height: 1.3; letter-spacing: -.025em; }
    .dsh-crew-ui .crew-panel-description { margin: 5px 0 0; font-size: 12px; opacity: .72; overflow-wrap: anywhere; }
    .dsh-crew-ui .crew-panel-badges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .dsh-crew-ui .crew-nav-link { display: inline-flex; align-items: center; justify-content: center; color: var(--crew-accent); background: transparent; border: 1px solid var(--crew-line); border-radius: 8px; padding: 7px 10px; font-size: 12px; font-weight: 600; text-decoration: none; flex-shrink: 0; }
    .dsh-crew-ui button:focus-visible, .dsh-crew-ui a:focus-visible, .dsh-crew-ui input:focus-visible, .dsh-crew-ui summary:focus-visible { outline: 2px solid var(--crew-accent); outline-offset: 3px; }
    .dsh-crew-ui button:disabled { cursor: not-allowed; opacity: .4; }
    .dsh-crew-ui .crew-nav-link:hover, .dsh-crew-ui .crew-section-trigger:hover, .dsh-crew-ui summary:hover { background: rgba(128,128,128,.09); }
    .dsh-crew-ui .crew-section-heading { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1; }
    .dsh-crew-ui .crew-section-title { font-weight: 650; font-size: 13px; }
    .dsh-crew-ui .crew-section-summary { font-size: 11.5px; opacity: .65; overflow-wrap: anywhere; }
    .dsh-crew-ui .crew-config-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; margin: 6px 0 2px; }
    @media (prefers-color-scheme: dark) { .dsh-crew-ui { --crew-accent: #8ab4ff; } }
    @media (prefers-reduced-motion: reduce) { .dsh-crew-ui * { transition: none !important; } }
  `}</style>;
}

export function PanelHeader({ title, eyebrow, description, href, linkText, children }: {
  title: string; eyebrow: string; description: string; href: string;
  linkText: string; children?: ReactNode;
}) {
  return <header className="crew-panel-header">
    <div className="crew-panel-heading">
      <div className="crew-eyebrow">{eyebrow}</div>
      <h2 className="crew-panel-title">{title}</h2>
      <p className="crew-panel-description">{description}</p>
      {children && <div className="crew-panel-badges">{children}</div>}
    </div>
    <a className="crew-nav-link" href={href} target="_blank" rel="noopener noreferrer">{linkText}</a>
  </header>;
}
