# Nutho Device Transfer

SillyTavern extension สำหรับย้ายข้อมูลระหว่างเครื่อง (เช่น PC กับ Android/Termux) ด้วยไฟล์ `.nsync` ไม่ต้อง host, ไม่ต้องใช้ Tailscale หรือ Tunnel

Move your SillyTavern data between devices with a single `.nsync` file. Client-only, no server plugin.

## ติดตั้ง

Extensions → Install extension → ใส่ URL ของ repo นี้ หรือก๊อปโฟลเดอร์ไปที่ `data/<user>/extensions/nutho-device-transfer`

## วิธีใช้

1. **เครื่องต้นทาง:** Extensions → Nutho Device Transfer → เลือกหมวด → Export ได้ไฟล์ `.nsync`
2. ส่งไฟล์ไปเครื่องปลายทางเอง (LINE, Drive, USB)
3. **เครื่องปลายทาง:** Import → เลือกไฟล์ → ดูรายการที่สแกนเทียบแล้ว ติ๊กเลือก → นำเข้า
4. จดรหัส 4 ตัวที่ขึ้นหลังนำเข้า แล้วกด "อีกเครื่องรับแล้ว" ที่เครื่องต้นทาง ครั้งหน้าจะส่งเฉพาะที่เปลี่ยน

## ย้ายอะไรบ้าง

การตั้งค่า, ตัวละคร (การ์ด + รูป), แชท, กลุ่ม + แชทกลุ่ม, World Info, presets, ธีม, พื้นหลัง, รูป Persona, Quick Replies และรายการ Extensions (ติดตั้งใหม่จาก git URL ที่ปลายทาง)

**ไม่ย้าย:** API key (ไม่เคย), sprites, Data Bank, vectors, assets

## การ merge

| กรณี | ผล |
|---|---|
| ของใหม่ | นำเข้า |
| เหมือนกันแล้ว | ข้าม |
| อีกเครื่องเปลี่ยน เครื่องนี้ไม่ได้แก้ | อัปเดต |
| แชทที่ต่อกันได้ | ต่อยอดให้ |
| แชทที่แยกทางกัน / ตัวละครที่แก้ทั้งสองฝั่ง | เก็บทั้งสอง เป็นไฟล์ใหม่ `... (จาก <เครื่อง>)` |
| การตั้งค่าที่ชนกัน | ไม่ถูกติ๊กให้ ต้องเลือกเอง |

ไฟล์ `.nsync` คือ zip ธรรมดา ไม่เข้ารหัส เก็บให้ปลอดภัยเอง

## ข้อจำกัด

- ทดสอบกับ SillyTavern 1.19 บน PC (Chrome) ยังไม่ได้ทดสอบกว้างบน Android
- ถ้าใช้กับเซิร์ฟเวอร์ที่เปิด reverse proxy อาจติดขีดจำกัดขนาดอัปโหลดของ proxy

## License

MIT
