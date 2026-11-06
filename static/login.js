document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = document.getElementById("btn"), err = document.getElementById("err");
  btn.disabled = true; err.textContent = "";
  try {
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "wt" },
      body: JSON.stringify({ password: document.getElementById("pw").value }),
    });
    if (r.ok) { location.href = "/"; return; }
    const j = await r.json().catch(() => ({}));
    err.textContent = j.detail || ("ผิดพลาด " + r.status);
  } catch (_) {
    err.textContent = "เชื่อมต่อเซิร์ฟเวอร์ไม่ได้";
  } finally {
    btn.disabled = false;
  }
});
