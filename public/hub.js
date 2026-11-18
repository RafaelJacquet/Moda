import { initTopbar, fetchStatus } from '/topbar.js';

initTopbar('/');

const el = document.getElementById('hub-status');
fetchStatus().then((s) => {
  const chip = (on, onText, offText) =>
    `<span class="status-chip ${on ? 'on' : 'off'}">${on ? '●' : '○'} ${on ? onText : offText}</span>`;
  el.innerHTML =
    chip(s.blender, 'Blender connecté', 'Blender hors ligne — lancez « docker compose up -d blender »') +
    chip(s.claude, 'Claude API active', 'Claude API non configurée — générateur en mode démo') +
    chip(s.smtp, 'Emails SMTP actifs', 'SMTP non configuré — codes affichés en console serveur');
});
