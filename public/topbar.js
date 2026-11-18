// Barre du haut commune : affiche l'utilisateur connecté + déconnexion.
export async function initTopbar(active) {
  const nav = document.querySelector(`.topbar nav a[href="${active}"]`);
  if (nav) nav.classList.add('active');

  try {
    const res = await fetch('/api/auth/me');
    if (!res.ok) throw new Error();
    const { email } = await res.json();
    const el = document.getElementById('user-email');
    if (el) el.textContent = email;
  } catch {
    window.location.href = '/login';
    return;
  }

  document.getElementById('logout-btn')?.addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/login';
  });
}

export async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    return res.ok ? await res.json() : { claude: false, blender: false, smtp: false };
  } catch {
    return { claude: false, blender: false, smtp: false };
  }
}
