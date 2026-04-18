const form = document.getElementById('loginForm');
const msg = document.getElementById('msg');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  msg.textContent = 'Đang đăng nhập...';
  const fd = new FormData(form);
  const body = new URLSearchParams(fd);
  try {
    const res = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await res.json();
    if (!data.ok) {
      msg.textContent = data.error === 'too_many_attempts' ? `Thử lại sau ${data.retryAfterSec}s` : 'Sai tài khoản hoặc mật khẩu';
      return;
    }
    location.href = '/admin';
  } catch {
    msg.textContent = 'Không kết nối được tới server.';
  }
});
