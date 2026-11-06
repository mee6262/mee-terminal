# PERF_PLAN — web_terminal ลื่นขึ้นโดยราคาเรียลไทม์เท่าเดิม

กติกา: ห้ามหน่วงราคา (ไม่ batch tick ฝั่ง server, ไม่ throttle อินดิเคเตอร์แท่งปัจจุบัน). ทำทีละข้อ วัดก่อน/หลัง, commit ทีละข้อ

ตัดออก: gateway รวม tick 100-150ms (หน่วงราคา), throttle อินดิเคเตอร์ 4 ครั้ง/วิ (เส้นช้ากว่าราคา), minify/build step

## Checklist
- [x] 1 tick -> เก็บ state.quotes ทันที, วาด (watchlist/ticket/bid-ask line) รวม 1 ครั้งต่อ rAF ด้วยค่าล่าสุด (app.js flushTicks)
- [ ] 0 วัด: ?perf=1 นับ tick/s, ms ต่ออินดิเคเตอร์, จำนวน paint; เกณฑ์ <16ms/เฟรม
- [x] 2 ตาราง positions: sig โครงสร้าง (ticket/type/vol/open/sl/tp/magic/journal/digits) เท่าเดิม -> แก้แค่ข้อความ/คลาสเซลล์ (renderTable sig); การ์ดมือถือ incremental อยู่แล้ว; orders/account worker ส่งเฉพาะเมื่อเปลี่ยนอยู่แล้ว (_last_state_sig)
- [~] 3 ข้าม: crossTimer ทำงานเฉพาะตอน crosshair แสดง แล้วหยุดเอง ต้นทุนเล็กมาก; เปลี่ยนเป็น event เสี่ยงบั๊กป้ายค้างบนมือถือกลับมา
- [x] 4 (แบบไม่เปลี่ยนผล ไม่หน่วง) วัด calc 5000 แท่ง: Mxwll 24->6.4ms (NY tz cache ต่อชั่วโมง + sort percentile ครั้งเดียว), Sessions/TPO 22-27->7-13ms (tz cache + cache session parse), LZ 3.7 / OFV 3.5 / VPOB 0.4 คงเดิม; ผล JSON ตรงของเดิม 100% (รวมช่วง DST); onBars ข้ามแท่งที่เหมือนเดิม -> calc ต่อ bars msg 2->1 ครั้ง. offscreen canvas reuse มีอยู่แล้ว. incremental แท่งสุดท้าย: ไม่ทำ (ต้องแก้ตรรกะทุกตัว เสี่ยงผลเพี้ยน) — ทำเมื่อผลวัดยังไม่พอ
- [x] 5 ChartPanel.isHidden (document.hidden หรือ el ไม่มี client rect): onBars พักแท่งใน held Map(ts) ไม่ calc/วาด; flushHeld ตอน visibilitychange / resizeAll / ทุก 1s; init reload ล้าง held; applyBars แก้ได้แค่ >= แท่งก่อนสุดท้าย; paintCd ข้ามกราฟที่ซ่อน. tick วาดผ่าน rAF หยุดเองตอนซ่อนอยู่แล้ว (#1)
- [x] 6 มีอยู่แล้วส่วนใหญ่: timer 3s ข้ามเมื่อ document.hidden / ไม่มีตัวบ่งชี้ flow เปิด, symbol ไม่ใช่ BTC/ETH ไม่ fetch; เพิ่ม: ข้ามกราฟที่ isHidden
- [~] 7 ข้าม: script ทั้งหมดอยู่ท้าย <body> อยู่แล้ว (HTML parse เสร็จก่อนรัน) defer ไม่ได้อะไรเพิ่ม
- [x] 9 gzip มีที่ Caddy แล้ว; ตัวปัญหาจริง = ทุก response no-store -> โหลด static ~776KB ทุกครั้ง. แก้: versioned_html ใส่ ?v=sha1(เนื้อไฟล์) แคชตาม mtime (pull แล้วรีเฟรชได้ไฟล์ใหม่ ไม่ต้อง restart), /static?v= -> private max-age=1y immutable, ไม่มี v -> no-cache (ETag 304), html ยัง no-store. โหลดครั้งที่ 2: 776KB -> 0
- [x] 12 มีอยู่แล้วใน worker._poll_state (_last_state_sig) — ไม่ต้องทำ
- [x] 13 เปลี่ยนเป็นแคชฝั่ง browser (worker อยู่เครื่องเดียวกับ gateway -> แคชที่ gateway ไม่ได้อะไร คอขวดคือส่ง 1000 แท่งผ่านเน็ต): BAR_CACHE acct|sym|tf (12 ชุด, TTL 30 นาที); init ซ้ำ ดึง count = แท่งที่ผ่านไป+3 แล้วต่อกับชุดเดิม ต้องซ้อนกัน ไม่งั้นโหลดเต็ม. ทดสอบ M15->M5->M15: ดึง 4 แท่งแทน 1000 ตรงชุดเต็ม
- [x] 17 touchstart ที่แค่ stopPropagation (rtBtn, legend, objBar, replay bar) -> passive; ตัวที่ preventDefault (chart.js block capture, touchmove ลาก) คง passive:false. ผลเล็ก
- รอผลวัด: 8 lazy-load อินดิเคเตอร์, 15 จำกัด DPR (ตัวเลือก ค่าเริ่มต้นปิด), 16 ลดแท่งเริ่มต้นมือถือ (>= ที่อินดิเคเตอร์ต้องการ)
