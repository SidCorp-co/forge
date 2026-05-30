/* Forge UI Kit — Icon.jsx
   Lucide-style line icons (24x24, stroke 1.75, round caps), inlined so the kit
   is self-contained. Matches the iconography rules in the design system README.
   Usage: <Icon name="play" size={18} className="..." style={{color:'...'}} /> */

const FORGE_ICON_PATHS = {
  board:        '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  list:         '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3.5" y1="6" x2="3.51" y2="6"/><line x1="3.5" y1="12" x2="3.51" y2="12"/><line x1="3.5" y1="18" x2="3.51" y2="18"/>',
  pipeline:     '<circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><circle cx="19" cy="12" r="2"/><path d="M7 6h6a4 4 0 0 1 4 4v0"/><path d="M7 18h6a4 4 0 0 0 4-4v0"/>',
  server:       '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><line x1="7" y1="7.5" x2="7.01" y2="7.5"/><line x1="7" y1="16.5" x2="7.01" y2="16.5"/>',
  monitor:      '<rect x="2.5" y="3.5" width="19" height="13" rx="2"/><line x1="8" y1="20.5" x2="16" y2="20.5"/><line x1="12" y1="16.5" x2="12" y2="20.5"/>',
  activity:     '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  clock:        '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/>',
  search:       '<circle cx="11" cy="11" r="7.5"/><line x1="21" y1="21" x2="16.5" y2="16.5"/>',
  bell:         '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  plus:         '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  play:         '<polygon points="6 4 20 12 6 20 6 4"/>',
  pause:        '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  stop:         '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  check:        '<polyline points="20 6 9 17 4 12"/>',
  x:            '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  chevronDown:  '<polyline points="6 9 12 15 18 9"/>',
  chevronRight: '<polyline points="9 6 15 12 9 18"/>',
  chevronUpDown:'<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  more:         '<circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/>',
  settings:     '<path d="M12.2 2h-.4a2 2 0 0 0-2 2 1.7 1.7 0 0 1-2.5 1.5 2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7A1.7 1.7 0 0 1 4 12a1.7 1.7 0 0 1-1 1.5 2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7A1.7 1.7 0 0 1 7.8 20a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2 1.7 1.7 0 0 1 2.5-1.5 2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7A1.7 1.7 0 0 1 20 12a1.7 1.7 0 0 1 1-1.5 2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7A1.7 1.7 0 0 1 16.2 4a2 2 0 0 0-2-2Z"/><circle cx="12" cy="12" r="2.6"/>',
  rerun:        '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><polyline points="3 3 3 8 8 8"/>',
  fork:         '<circle cx="6" cy="5" r="2.2"/><circle cx="6" cy="19" r="2.2"/><circle cx="18" cy="9" r="2.2"/><path d="M6 7.2v9.6"/><path d="M18 11.2a6 6 0 0 1-6 6H8"/>',
  branch:       '<line x1="6" y1="4" x2="6" y2="20"/><circle cx="6" cy="20" r="1.8"/><circle cx="6" cy="4" r="1.8"/><circle cx="18" cy="7" r="1.8"/><path d="M18 8.8a8 8 0 0 1-8 8"/>',
  trash:        '<polyline points="3 6 21 6"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/>',
  arrowRight:   '<line x1="4" y1="12" x2="19" y2="12"/><polyline points="13 6 19 12 13 18"/>',
  agent:        '<path d="M12 3l1.8 4.2L18 9l-4.2 1.8L12 15l-1.8-4.2L6 9l4.2-1.8L12 3Z"/><path d="M18.5 15.5l.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8Z"/>',
  folder:       '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  calendar:     '<rect x="3" y="4.5" width="18" height="16" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="8" y1="2.5" x2="8" y2="6"/><line x1="16" y1="2.5" x2="16" y2="6"/>',
  shield:       '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/>',
  cpu:          '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
  dollar:       '<line x1="12" y1="2" x2="12" y2="22"/><path d="M17 6.5H9.5a3 3 0 0 0 0 6h5a3 3 0 0 1 0 6H6"/>',
  lock:         '<rect x="4.5" y="11" width="15" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  mail:         '<rect x="2.5" y="4.5" width="19" height="15" rx="2"/><polyline points="3 6 12 13 21 6"/>',
  github:       '<path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12 12 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  dot:          '<circle cx="12" cy="12" r="4"/>',
  filter:       '<polygon points="3 4 21 4 14 12.5 14 19 10 21 10 12.5 3 4"/>',
  inbox:        '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.5 6.5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-5.5A2 2 0 0 0 16.8 5H7.2a2 2 0 0 0-1.7 1.5Z"/>',
  link:         '<path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1.5-1.5"/>',
  star:         '<polygon points="12 2.5 15 8.7 22 9.6 17 14.3 18.2 21 12 17.6 5.8 21 7 14.3 2 9.6 9 8.7 12 2.5"/>',
  archive:      '<rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8"/><line x1="10" y1="12" x2="14" y2="12"/>',
  grid:         '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/>',
  rows:         '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="13" width="18" height="5" rx="1.5"/>',
  alert:        '<path d="M12 3 2 20h20L12 3Z"/><line x1="12" y1="10" x2="12" y2="14"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
};

function Icon({ name, size = 18, strokeWidth = 1.75, className = '', style = {} }) {
  const d = FORGE_ICON_PATHS[name] || FORGE_ICON_PATHS.dot;
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round"
      className={className} style={{ flex: 'none', ...style }}
      dangerouslySetInnerHTML={{ __html: d }}
    />
  );
}

window.Icon = Icon;
