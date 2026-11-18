// Connexion en deux temps : email @frenchflair.pro -> code OTP -> session.
const emailForm = document.getElementById('email-form');
const codeForm = document.getElementById('code-form');
const emailInput = document.getElementById('email');
const codeInput = document.getElementById('code');
const emailMsg = document.getElementById('email-msg');
const codeMsg = document.getElementById('code-msg');
const emailBtn = document.getElementById('email-btn');
const codeBtn = document.getElementById('code-btn');

function setMsg(el, text, kind) {
  el.textContent = text;
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
  return data;
}

emailForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = emailInput.value.trim().toLowerCase();
  if (!email.endsWith('@frenchflair.pro')) {
    return setMsg(emailMsg, 'Seules les adresses @frenchflair.pro sont autorisées.', 'error');
  }
  emailBtn.disabled = true;
  setMsg(emailMsg, 'Connexion…');
  try {
    const data = await post('/api/auth/request', { email });
    if (data.direct) {
      window.location.href = '/';
      return;
    }
    emailForm.classList.add('hidden');
    codeForm.classList.remove('hidden');
    setMsg(codeMsg, `Code envoyé à ${email} (valable 10 min).`, 'ok');
    codeInput.focus();
  } catch (err) {
    setMsg(emailMsg, err.message, 'error');
  } finally {
    emailBtn.disabled = false;
  }
});

codeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  codeBtn.disabled = true;
  setMsg(codeMsg, 'Vérification…');
  try {
    await post('/api/auth/verify', {
      email: emailInput.value.trim().toLowerCase(),
      code: codeInput.value.trim(),
    });
    window.location.href = '/';
  } catch (err) {
    setMsg(codeMsg, err.message, 'error');
    codeBtn.disabled = false;
  }
});

document.getElementById('back-btn').addEventListener('click', () => {
  codeForm.classList.add('hidden');
  emailForm.classList.remove('hidden');
  setMsg(codeMsg, '');
  emailInput.focus();
});
