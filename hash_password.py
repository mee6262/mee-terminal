"""สร้าง WT_PASS_HASH: python hash_password.py แล้วพิมพ์รหัส (ไม่แสดงบนจอ) -> คัดลอกบรรทัดผลไปใส่ web_terminal/.env"""
import getpass
import sys

from auth import hash_password

pw = getpass.getpass("รหัสผ่านใหม่: ")
if len(pw) < 12:
    sys.exit("รหัสผ่านต้องยาวอย่างน้อย 12 ตัวอักษร")
if pw != getpass.getpass("พิมพ์ซ้ำ: "):
    sys.exit("รหัสผ่านไม่ตรงกัน")
print(f"WT_PASS_HASH={hash_password(pw)}")
