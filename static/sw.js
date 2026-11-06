// Mee Terminal — service worker สำหรับแจ้งเตือน Web Push (ไม่แคชหน้าเว็บ)
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "Mee Terminal", {
    body: d.body || "", tag: d.tag || undefined, renotify: !!d.tag,
    icon: "/static/icon-192.png", badge: "/static/favicon-32.png", data: { url: "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = all.find((c) => new URL(c.url).origin === self.location.origin);
    if (open) return open.focus();
    return self.clients.openWindow("/");
  })());
});
