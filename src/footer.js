// --- footer.js ---
// Fetches the shared "Institut für digitale Herausforderungen" footer
// content (same source used across the family of nickyreinert projects)
// and renders it as a single centered line, mirroring the layout used on
// https://8.1-1-1.de/activities ("Powered by A · B · C · ...").

const FOOTER_URL = 'https://raw.githubusercontent.com/nickyreinert/0.1-1-1.de/main/footer.json';

// Kept as a fallback in case the fetch fails (offline, CORS, rate limit, ...).
const FALLBACK_FOOTER = {
  mother: { caption: 'Institut für digitale Herausforderungen', url: 'https://institut-fdh.de' },
  portfolio: [
    { caption: 'GPS route renderer', url: 'https://8.1-1-1.de' },
    { caption: 'http mirror', url: 'https://6.1-1-1.de' },
    { caption: 'speed test', url: 'https://7.1-1-1.de' },
    { caption: 'p2p sharing', url: 'https://9.1-1-1.de' }
  ],
  support: { caption: 'buy me a coffee', url: 'https://buymeacoffee.com/nickyreinert' }
};

function link(entry) {
  const a = document.createElement('a');
  a.href = entry.url;
  a.textContent = entry.caption;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function render_footer(el, footerData, poweredByLabel) {
  el.innerHTML = '';
  const entries = [
    footerData.mother,
    ...(footerData.portfolio || []),
    footerData.support
  ].filter(Boolean);

  el.appendChild(document.createTextNode(poweredByLabel + ' '));
  entries.forEach((entry, i) => {
    el.appendChild(link(entry));
    if (i < entries.length - 1) {
      el.appendChild(document.createTextNode(' · '));
    }
  });
}

export async function load_footer(elementId, poweredByLabel) {
  const el = document.getElementById(elementId);
  if (!el) return;
  try {
    const res = await fetch(FOOTER_URL);
    if (!res.ok) throw new Error('footer fetch failed: ' + res.status);
    const footerData = await res.json();
    render_footer(el, footerData, poweredByLabel);
  } catch (e) {
    console.warn('Falling back to built-in footer data:', e);
    render_footer(el, FALLBACK_FOOTER, poweredByLabel);
  }
}