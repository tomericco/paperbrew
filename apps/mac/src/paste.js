const form = document.getElementById('f');
const input = document.getElementById('code');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = '';
  const res = await window.paperbrew.submitCode(input.value);
  if (!res.ok) msg.textContent = res.error || 'Could not connect.';
});
