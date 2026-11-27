// The Orca panel's stylesheet: the Paseo panel's layout, sizes and colour logic
// (client/panel.tsx) in CSS. Surfaces, text and borders come from Orca's theme variables, so
// the panel follows Orca's light/dark theme; the status colours are the Paseo palette.
export const CSS = `
:root {
  --qm-s0: var(--orca-background, #0c0c0e);
  --qm-s1: var(--orca-card, #141417);
  --qm-s2: var(--orca-muted, #222227);
  --qm-border: var(--orca-border, #2b2b31);
  --qm-fg: var(--orca-foreground, #ececf0);
  --qm-muted: var(--orca-muted-foreground, #9b9ba3);
  --qm-accent: #3b82f6;
  --qm-accent-fg: #ffffff;
  --qm-success: #34d399;
  --qm-warning: #f59e0b;
  --qm-danger: #f87171;
  --qm-purple: #a855f7;
  --qm-sans: var(--orca-font-sans, system-ui, -apple-system, "Segoe UI", sans-serif);
  --qm-mono: var(--orca-font-mono, ui-monospace, "Cascadia Code", Menlo, Consolas, monospace);
  color-scheme: dark;
}
html.light {
  --qm-accent: #2563eb;
  --qm-success: #059669;
  --qm-warning: #d97706;
  --qm-danger: #dc2626;
  --qm-purple: #9333ea;
  color-scheme: light;
}
* { box-sizing: border-box; }
html, body { margin: 0; background: var(--qm-s0); color: var(--qm-fg); }
body { font-family: var(--qm-sans); font-size: 12px; line-height: 1.35; -webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { cursor: default; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--orca-ring, var(--qm-accent)); outline-offset: 1px; }
.qm-icon { flex: none; display: block; }
.qm-mono { font-family: var(--qm-mono); }

#qm-root { display: flex; flex-direction: column; gap: 14px; padding: 14px 14px 24px; }

/* Header */
.qm-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }
.qm-title-block { flex: 1; display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.qm-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; }
.qm-title .qm-icon { color: var(--qm-accent); }
.qm-subtitle { color: var(--qm-muted); font-size: 11.5px; }
.qm-header-actions { display: flex; align-items: center; gap: 6px; }

/* Buttons */
.qm-btn {
  display: inline-flex; align-items: center; gap: 5px; padding: 6px 9px; border-radius: 8px;
  border: 1px solid var(--qm-border); background: var(--qm-s1); color: var(--qm-muted);
  font-size: 11.5px; font-weight: 600;
}
.qm-btn:hover:not(:disabled) { background: var(--qm-s2); }
.qm-btn.is-fg { color: var(--qm-fg); background: var(--qm-s2); font-size: 12.5px; padding: 7px 12px; }
.qm-icon-btn { padding: 6px; border-radius: 8px; border: 1px solid var(--qm-border); background: var(--qm-s1); color: var(--qm-muted); display: inline-flex; }
.qm-icon-btn:hover, .qm-icon-btn.is-active { background: var(--qm-s2); color: var(--qm-fg); }
.qm-primary {
  padding: 7px 12px; border-radius: 8px; border: 0; background: var(--qm-accent); color: var(--qm-accent-fg);
  font-size: 12.5px; font-weight: 600;
}
.qm-primary:disabled { background: var(--qm-s2); color: var(--qm-muted); opacity: .6; }
.qm-link {
  display: inline-flex; align-items: center; gap: 5px; padding: 2px 0; border: 0; background: none;
  color: var(--qm-accent); font-size: 11.5px; font-weight: 600; align-self: flex-start;
}
.qm-link:hover { text-decoration: underline; }
.qm-link.is-danger { color: var(--qm-danger); }

/* Banners */
.qm-banner { padding: 7px 10px; border-radius: 8px; border: 1px solid; font-size: 11.5px; display: flex; flex-direction: column; gap: 6px; }
.qm-banner.is-ok { background: rgba(52, 211, 153, .12); border-color: rgba(52, 211, 153, .35); color: var(--qm-success); }
.qm-banner.is-warn { background: rgba(245, 158, 11, .12); border-color: rgba(245, 158, 11, .35); color: var(--qm-warning); }
.qm-banner.is-error { background: rgba(239, 68, 68, .1); border-color: rgba(239, 68, 68, .4); color: var(--qm-danger); padding: 10px; border-radius: 10px; font-size: 12px; line-height: 17px; }
.qm-banner.is-info { background: rgba(59, 130, 246, .1); border-color: rgba(59, 130, 246, .35); color: var(--qm-fg); }
.qm-banner-actions { display: flex; gap: 6px; }
.qm-banner-actions .qm-apply { padding: 4px 10px; }
.qm-cmd {
  font-family: var(--qm-mono); font-size: 11px; color: var(--qm-fg); background: var(--qm-s0);
  border: 1px solid var(--qm-border); border-radius: 6px; padding: 5px 7px; white-space: pre-wrap;
  word-break: break-all; user-select: all;
}
.qm-loading { padding: 28px; display: flex; flex-direction: column; align-items: center; gap: 8px; color: var(--qm-muted); font-size: 12px; }

/* Cards */
.qm-card { background: var(--qm-s1); border: 1px solid var(--qm-border); border-radius: 12px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
.qm-card-head { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }
.qm-card-head h2 { margin: 0; font-size: 12.5px; font-weight: 700; display: flex; align-items: center; gap: 6px; }
.qm-hint { color: var(--qm-muted); font-size: 11px; }

/* Segmented switcher */
.qm-seg { display: flex; gap: 2px; padding: 2px; border-radius: 8px; border: 1px solid var(--qm-border); background: var(--qm-s0); }
.qm-seg button { padding: 4px 8px; border: 0; border-radius: 6px; background: transparent; color: var(--qm-muted); font-size: 11px; font-weight: 500; }
.qm-seg button.is-active { background: var(--qm-s2); color: var(--qm-fg); font-weight: 700; }
.qm-seg.is-small button { padding: 3.5px 8px; }

/* Ranked models */
.qm-recs { display: flex; flex-direction: column; gap: 7px; }
.qm-rec {
  display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 9px 10px;
  border-radius: 9px; background: var(--qm-s0); border: 1px solid var(--qm-border);
}
.qm-rec.is-top { background: var(--qm-s2); border-color: var(--qm-accent); }
.qm-rec-main { flex: 1; display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.qm-rec-title, .qm-rec-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.qm-rec-name { font-size: 13px; font-weight: 700; }
.qm-rec-meta { color: var(--qm-muted); font-size: 11px; }
.qm-chip { padding: 1.5px 6px; border-radius: 5px; background: var(--qm-s1); border: 1px solid var(--qm-border); color: var(--qm-muted); font-size: 10px; font-weight: 600; }
.qm-rec-side { display: flex; align-items: center; gap: 8px; }
.qm-score { font-family: var(--qm-mono); font-size: 12px; font-weight: 700; color: var(--qm-muted); }
.qm-score.is-top { color: var(--qm-accent); }
.qm-apply {
  padding: 5px 10px; border-radius: 7px; border: 1px solid var(--qm-border); background: var(--qm-s1);
  color: var(--qm-fg); font-size: 11.5px; font-weight: 600;
}
.qm-apply:hover:not(:disabled) { background: var(--qm-s2); }
.qm-apply.is-top { background: var(--qm-accent); border-color: var(--qm-accent); color: var(--qm-accent-fg); }
.qm-apply.is-top:hover:not(:disabled) { opacity: .85; background: var(--qm-accent); }
.qm-apply.is-applied { background: var(--qm-success); border-color: var(--qm-success); color: var(--qm-accent-fg); }
.qm-apply:disabled { opacity: .6; }
.qm-why { color: var(--qm-muted); font-size: 11.5px; line-height: 16px; }
.qm-why strong { color: var(--qm-fg); font-weight: 600; }

/* Mode colours (Paseo's modeColors) */
.mode-HAMMER { --mode-bg: rgba(245, 158, 11, .16); --mode-fg: var(--qm-warning); --mode-border: rgba(245, 158, 11, .42); }
.mode-PUSH { --mode-bg: rgba(59, 130, 246, .15); --mode-fg: var(--qm-accent); --mode-border: rgba(59, 130, 246, .38); }
.mode-BALANCED { --mode-bg: rgba(52, 211, 153, .14); --mode-fg: var(--qm-success); --mode-border: rgba(52, 211, 153, .34); }
.mode-CONSERVE { --mode-bg: rgba(248, 113, 113, .14); --mode-fg: var(--qm-danger); --mode-border: rgba(248, 113, 113, .35); }
.mode-THROTTLED_5H, .mode-EXHAUSTED { --mode-bg: rgba(239, 68, 68, .2); --mode-fg: var(--qm-danger); --mode-border: rgba(239, 68, 68, .5); }
.mode-UNTRACKED { --mode-bg: var(--qm-s2); --mode-fg: var(--qm-muted); --mode-border: var(--qm-border); }
.qm-mode-text { color: var(--mode-fg); font-weight: 700; }
.qm-pill { padding: 2px 8px; border-radius: 999px; background: var(--mode-bg); border: 1px solid var(--mode-border); color: var(--mode-fg); font-size: 10px; font-weight: 700; white-space: nowrap; }

/* Pools */
.qm-pools { display: flex; flex-direction: column; gap: 8px; }
.qm-pool { background: var(--qm-s0); border: 1px solid var(--qm-border); border-radius: 9px; padding: 10px; display: flex; flex-direction: column; gap: 7px; }
.qm-pool-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.qm-pool-name { display: flex; align-items: baseline; gap: 6px; flex: 1; min-width: 0; }
.qm-pool-name strong { font-size: 12.5px; font-weight: 700; }
.qm-pool-name span { color: var(--qm-muted); font-size: 11px; }
.qm-bar-row { display: flex; align-items: center; gap: 8px; }
.qm-bar-label { width: 44px; flex: none; color: var(--qm-muted); font-size: 11px; }
.qm-bar { flex: 1; height: 5px; border-radius: 999px; background: var(--qm-s2); overflow: hidden; }
.qm-bar > i { display: block; height: 100%; border-radius: 999px; background: var(--fill); }
.qm-bar-text { width: 124px; flex: none; text-align: right; color: var(--qm-muted); font-size: 11px; font-family: var(--qm-mono); }
.qm-burn { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding-top: 4px; border-top: 1px solid var(--qm-border); color: var(--qm-muted); font-size: 11px; }
.qm-eta { display: inline-flex; align-items: center; gap: 4px; border-radius: 6px; white-space: nowrap; }
.qm-eta.is-warning { padding: 2px 7px; background: rgba(245, 158, 11, .14); color: var(--qm-warning); font-weight: 700; }
.qm-eta.is-danger { padding: 2px 7px; background: rgba(239, 68, 68, .16); color: var(--qm-danger); font-weight: 700; }
.qm-untracked { color: var(--qm-muted); font-size: 11px; line-height: 15px; }
.qm-untracked span[title] { text-decoration: underline dotted; text-underline-offset: 2px; cursor: help; }
.qm-reasons { margin: 0; padding: 0 0 0 14px; color: var(--qm-muted); font-size: 11px; line-height: 15px; }
.qm-reasons b { color: var(--qm-fg); font-weight: 600; }

/* Banked resets */
.qm-banked { display: flex; flex-direction: column; gap: 5px; padding-top: 5px; border-top: 1px solid var(--qm-border); }
.qm-banked-pills { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.qm-banked-pill { display: inline-flex; align-items: center; gap: 5px; padding: 2.5px 7px; border-radius: 6px; background: var(--qm-s1); border: 1px solid var(--qm-border); font-size: 10.5px; font-weight: 700; font-family: var(--qm-mono); color: var(--qm-accent); }
.qm-banked-pill.is-warn { color: var(--qm-warning); }
.qm-banked-pill.is-danger { color: var(--qm-danger); }
.qm-use-reset { padding: 1px 5px; border-radius: 4px; border: 0; background: var(--qm-s2); color: var(--qm-muted); font: inherit; font-size: 9.5px; font-weight: 600; cursor: pointer; }
.qm-use-reset:hover { color: var(--qm-fg); }
.qm-reset-advice { display: flex; flex-direction: column; gap: 1px; padding: 5px 8px; border-radius: 7px; border: 1px solid var(--qm-border); }
.qm-reset-advice strong { font-size: 11px; font-weight: 700; }
.qm-reset-advice span { font-size: 10px; color: var(--qm-muted); }
.qm-reset-advice.is-ok { background: rgba(52, 211, 153, .14); border-color: rgba(52, 211, 153, .4); }
.qm-reset-advice.is-ok strong { color: var(--qm-success); }
.qm-reset-advice.is-warn { background: rgba(245, 158, 11, .14); border-color: rgba(245, 158, 11, .4); }
.qm-reset-advice.is-warn strong { color: var(--qm-warning); }
.qm-reset-advice.is-danger { background: rgba(239, 68, 68, .16); border-color: rgba(239, 68, 68, .45); }
.qm-reset-advice.is-danger strong { color: var(--qm-danger); }
.qm-reset-form { background: var(--qm-s0); border: 1px solid var(--qm-border); border-radius: 9px; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.qm-reset-form-title { font-size: 11.5px; font-weight: 700; color: var(--qm-fg); }
.qm-reset-form-row { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 6px; }
.qm-chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.qm-chip-btn { padding: 3px 7px; border-radius: 6px; border: 1px solid var(--qm-border); background: var(--qm-s1); color: var(--qm-muted); font: inherit; font-size: 10.5px; font-weight: 500; cursor: pointer; }
.qm-chip-btn.is-active { border-color: var(--qm-accent); background: rgba(59, 130, 246, .14); color: var(--qm-accent); font-weight: 700; }

/* Costs */
.qm-kpis { display: flex; gap: 8px; }
.qm-kpi { flex: 1; min-width: 0; background: var(--qm-s0); border: 1px solid var(--qm-border); border-radius: 9px; padding: 9px; display: flex; flex-direction: column; gap: 2px; }
.qm-kpi-label { color: var(--qm-muted); font-size: 10.5px; }
.qm-kpi-value { font-family: var(--qm-mono); font-size: 16px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qm-kpi-value.is-success { color: var(--qm-success); }
.qm-kpi-sub { color: var(--qm-muted); font-size: 10px; }
.qm-kpi-sub.is-warning { color: var(--qm-warning); }
.qm-split { display: flex; flex-direction: column; gap: 5px; }
.qm-split-bar { display: flex; height: 6px; border-radius: 999px; overflow: hidden; background: var(--qm-s2); }
.qm-split-bar > i { display: block; height: 100%; }
.qm-legend { display: flex; flex-wrap: wrap; gap: 10px; font-size: 10.5px; color: var(--qm-muted); }
.c-accent { color: var(--qm-accent); } .c-success { color: var(--qm-success); } .c-warning { color: var(--qm-warning); } .c-purple { color: var(--qm-purple); }
.bg-accent { background: var(--qm-accent); } .bg-success { background: var(--qm-success); } .bg-warning { background: var(--qm-warning); } .bg-purple { background: var(--qm-purple); }
.qm-cost-pools, .qm-cost-models { display: flex; flex-direction: column; gap: 5px; }
.qm-cost-models { gap: 4px; }
.qm-cost-pool { background: var(--qm-s0); border: 1px solid var(--qm-border); border-radius: 8px; padding: 7px 9px; display: flex; flex-direction: column; gap: 4px; }
.qm-cost-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.qm-cost-row strong { flex: 1; font-size: 11.5px; font-weight: 600; min-width: 0; }
.qm-cost-row .qm-mono { color: var(--qm-muted); font-size: 10.5px; }
.qm-cost-row .qm-amount { color: var(--qm-fg); font-size: 11.5px; font-weight: 700; min-width: 56px; text-align: right; font-family: var(--qm-mono); }
.qm-share { height: 3.5px; border-radius: 999px; background: var(--qm-s2); overflow: hidden; }
.qm-share > i { display: block; height: 100%; border-radius: 999px; background: var(--qm-accent); }
.qm-cost-model { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 5px 8px; border-radius: 7px; background: var(--qm-s0); border: 1px solid var(--qm-border); }
.qm-cost-model-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.qm-cost-model-main strong { font-size: 11px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.qm-cost-model-main span { color: var(--qm-muted); font-size: 10px; }
.qm-cost-model .qm-amount { font-family: var(--qm-mono); font-size: 11px; font-weight: 700; }
.qm-cost-model .qm-amount.is-unpriced { color: var(--qm-muted); }
.qm-footnote { color: var(--qm-muted); font-size: 10.5px; line-height: 14px; }
.qm-muted-text { color: var(--qm-muted); font-size: 11.5px; }
.qm-error-text { color: var(--qm-danger); font-size: 11.5px; }

/* Footer */
.qm-footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 2px; }
.qm-footer-status { display: flex; align-items: center; gap: 6px; color: var(--qm-muted); font-size: 11px; }
.qm-dot { width: 6px; height: 6px; border-radius: 3px; background: var(--qm-warning); }
.qm-dot.is-live { background: var(--qm-success); }
.qm-footer .qm-link { padding: 4px 8px; border-radius: 6px; font-size: 11.5px; }
.qm-footer .qm-link:hover { background: var(--qm-s2); text-decoration: none; }

/* Settings (Paseo's Settings → QuotaMax screen, inline) */
.qm-settings { padding: 0; gap: 0; }
.qm-settings .qm-card-head { padding: 12px 12px 0; }
.qm-settings-body { padding: 10px 12px 12px; display: flex; flex-direction: column; gap: 10px; }
.qm-setting-title { font-size: 13px; font-weight: 600; }
.qm-setting-desc { color: var(--qm-muted); font-size: 12px; line-height: 17px; margin-top: 3px; }
.qm-row { display: flex; align-items: center; gap: 8px; }
.qm-row.is-wrap { flex-wrap: wrap; }
.qm-input {
  flex: 1; min-width: 0; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--orca-input, var(--qm-border));
  background: var(--qm-s0); color: var(--qm-fg); font: inherit; font-size: 13px;
}
.qm-input::placeholder { color: var(--qm-muted); }
.qm-note { font-size: 12px; line-height: 17px; }
.qm-note.is-ok { color: var(--qm-success); } .qm-note.is-error { color: var(--qm-danger); }
.qm-setting-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px; border-top: 1px solid var(--qm-border); }
.qm-switch { flex: none; width: 34px; height: 20px; padding: 2px; border-radius: 999px; border: 0; background: var(--qm-s2); display: inline-flex; transition: background .15s; }
.qm-switch::after { content: ""; width: 16px; height: 16px; border-radius: 50%; background: var(--qm-fg); transition: transform .15s; }
.qm-switch[aria-checked="true"] { background: var(--qm-accent); }
.qm-switch[aria-checked="true"]::after { transform: translateX(14px); background: #fff; }

/* Spinners */
.qm-spinner { width: 12px; height: 12px; flex: none; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; display: inline-block; animation: qm-spin .8s linear infinite; opacity: .8; }
.qm-spinner.is-large { width: 18px; height: 18px; }
@keyframes qm-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .qm-spinner { animation-duration: 2.4s; } }
@media (max-width: 340px) { .qm-bar-text { width: 96px; } .qm-kpi-value { font-size: 14px; } }
`;
