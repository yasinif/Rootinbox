# راهنمای مانور و آزمایش محلی RootInbox (LAN Rehearsal)

این سند راهنمای گام‌به‌گام برای راه‌اندازی و اجرای مانور آزمایشی RootInbox در یک شبکه محلی فیزیکی (مانند Wi-Fi خانگی یا هات‌اسپات تلفن همراه) یا بر روی یک لپ‌تاپ است. این آزمون جهت اطمینان از بالا آمدن بی‌نقص واسط وب، ارتباط امن در بستر `HTTPS`، کارکرد بلادرنگ `WebSocket` و برقراری تماس صوتی/تصویری از طریق سرور رله `TURN` بدون نیاز به اتصال به اینترنت طراحی شده است.

> **تذکر شفاف درباره وضعیت امنیت:** تمامی ارتباطات در این مانور با پروتکل امن `TLS` (رمزنگاری لایه انتقال) محافظت می‌شوند. زیرساخت رمزنگاری سرتاسری (`E2EE`) در فازهای آزمایشی بعدی اضافه خواهد شد و در این نسخه ادعای رمزنگاری سرتاسری کامل وجود ندارد.

---

## ۱. حالت‌های اجرای مانور

### حالت الف: فقط با یک لپ‌تاپ (Laptop-only / Loopback)
اگر دستگاه دومی در دسترس ندارید، می‌توانید کل مانور را روی یک لپ‌تاپ اجرا کنید:
1. اسکریپت را اجرا کنید:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1 -LanIp 127.0.0.1
   ```
2. مرورگر اصلی (مثلاً Chrome) را باز کرده و به نشانی `https://127.0.0.1:8443` بروید و کاربر `alice` را بسازید.
3. یک پنجره محرمانه (Incognito / Guest Window) یا مرورگر دیگر (مثلاً Edge یا Firefox) باز کنید و با نشانی `https://127.0.0.1:8443` کاربر `bob` را ثبت‌نام کنید.
4. بین دو پنجره پیام متنی و فایل جابجا کرده و تماس صوتی/تصویری برقرار کنید.

### حالت ب: سناریوی دو‌دستگاهی بدون روتر (هات‌اسپات گوشی - Two-Device)
این سناریو برای شرایط اضطراری قطع اینترنت ایده‌آل است و نیازی به مودم یا اینترنت ندارد:
1. هات‌اسپات وای‌فای (`Mobile Hotspot`) گوشی را روشن کنید (دیتای سیم‌کارت می‌تواند کاملاً خاموش باشد).
2. لپ‌تاپ را به هات‌اسپات وای‌فای گوشی متصل کنید.
3. در لپ‌تاپ، اسکریپت را اجرا کنید:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1
   ```
   اسکریپت به صورت خودکار آی‌پی اختصاص‌یافته توسط هات‌اسپات (مثلاً `172.24.249.139` یا `192.168.43.x`) را شناسایی می‌کند.
4. کاربر اول روی لپ‌تاپ ثبت‌نام می‌کند و کاربر دوم روی گوشی با مراجعه به نشانی `https://<IP>:8443` وارد می‌شود.

---

## ۲. اجرای اسکریپت و پارامترهای جدید

### نحوه اجرای استاندارد (کامپایل خودکار):
```powershell
powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1
```

### نحوه اجرا با فایل باینری آماده (بدون نیاز به نصب Go یا Node یا اینترنت):
اگر بسته باینری آماده (`rootinbox.exe`) را در اختیار دارید:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1 -UseBinary "D:\rootinbox-emergency-kit\rootinbox.exe"
```

### نصب و حذف خودکار گواهی در ویندوز (`-InstallCa` و `-RemoveCa`):
- **نصب خودکار گواهی در مخزن معتبر ویندوز:**
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1 -InstallCa
  ```
- **حذف گواهی‌های آزمایشی پس از پایان مانور:**
  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1 -RemoveCa
  ```

### توقف سرور در حال اجرا:
```powershell
powershell -ExecutionPolicy Bypass -File scripts/lan-rehearsal.ps1 -Stop
```

---

## ۳. خودآزمایی خودکار سامانه (Self-Check Diagnostics)

بلافاصله پس از آماده شدن سرور، اسکریپت به صورت خودکار مؤلفه‌های حیاتی را ارزیابی کرده و جدولی مشابه زیر نمایش می‌دهد:

```text
================================================================================
 RUNNING LAN REHEARSAL SELF-CHECK
================================================================================

 SELF-CHECK RESULTS:
  [PASS] /health/ready is healthy JSON (not SPA shell)
  [PASS] Root / contains real app markers
  [PASS] Main JS asset loads with JavaScript MIME type
  [PASS] /device-check loads its bundled module script
  [PASS] Headless browser DOM sanity check

[+] All essential rehearsal self-checks PASSED!
```

اگر هر یک از این موارد `FAIL` شود، اسکریپت بلافاصله با پیام خطا و راهنمای رفع مشکل (`FIX HINT`) متوقف شده و از اجرای سرور با فایل‌های ناقص یا اشتباه جلوگیری می‌کند.

---

## ۴. راهنمای اتصال دستگاه‌ها و تنظیم گواهی امنیتی (`CA Certificate`)

### علت خطای "Not secure" در گوگل کروم و راهکار مخزن دستی ویندوز:
هنگامی که فایل گواهی `ca.crt` را با دو بار کلیک و جادوگر ویندوز (`Certificate Import Wizard`) نصب می‌کنید، گزینه پیش‌فرض ویندوز یعنی «انتخاب خودکار مخزن» فعال است. ویندوز گواهی‌های خودامضا را در مخزن `Intermediate Certification Authorities` قرار می‌دهد. مرورگرهای Chrome و Edge فقط گواهی‌هایی را معتبر می‌دانند که در مخزن ریشه اصلی یعنی `Trusted Root Certification Authorities` ذخیره شده باشند.
* **راهکار خودکار:** استفاده از سوئیچ `-InstallCa` در اسکریپت (که دستور `certutil -addstore -f ROOT` را اجرا می‌کند).
* **راهکار دستی:** در جادوگر نصب، حتماً گزینه دوم یعنی «Place all certificates in the following store» را انتخاب کنید، روی **Browse** بزنید و پوشه **Trusted Root Certification Authorities** را دستی انتخاب نمایید.

---

### مراحل تنظیم در گوشی‌های آیفون (Apple iOS / Safari):
1. در سافاری گوشی به نشانی `http://<IP>:8080/ca.crt` بروید و دکمه **Allow** را بزنید تا پروفایل دانلود شود.
2. به بخش تنظیمات گوشی بروید: `Settings -> Profile Downloaded` و دکمه **Install** را بزنید.
3. **گام بسیار مهم (فعال‌سازی اعتماد کامل):**
   به مسیر زیر بروید:
   `Settings -> General -> About -> Certificate Trust Settings`
   در بخش **Enable full trust for root certificates**، کلید مقابل گواهی **RootInbox Private CA** را روشن (**ON**) کنید.
4. در سافاری آدرس `https://<IP>:8443/device-check` را باز کرده و مطمئن شوید تست‌های مرورگر همگی `PASS` می‌شوند.
5. به صفحه اصلی `https://<IP>:8443` رفته و ثبت‌نام کنید.

---

### مراحل تنظیم در گوشی‌های اندروید (Android / Chrome):
1. در مرورگر کروم گوشی به `https://<IP>:8443` بروید. اگر هشدار امنیتی نمایش داده شد، روی **Advanced** و سپس **Proceed to <IP> (unsafe)** بزنید.
2. در صورتی که دکمه ادامه نمایش داده نشد، کافی است در همان صفحه هشدار کلمه انگلیسی `thisisunsafe` را تایپ کنید.
3. همچنین می‌توانید فایل `http://<IP>:8080/ca.crt` را دانلود کرده و از بخش تنظیمات امنیت گوشی (`Security -> Install certificate -> CA certificate`) آن را نصب کنید.

---

## ۵. تنظیم فایروال ویندوز (Windows Firewall)

اگر گوشی هوشمند موفق به باز کردن نشانی لپ‌تاپ نشد، فایروال ویندوز مانع شده است. یک ترمینال PowerShell را با دسترسی **Run as Administrator** باز کرده و این دو دستور را اجرا کنید:

```powershell
# باز کردن پورت‌های وب و رله TURN
New-NetFirewallRule -DisplayName "RootInbox Rehearsal TCP" -Direction Inbound -LocalPort 8443,8080,3478 -Protocol TCP -Action Allow

# باز کردن پورت جریان صوتی/تصویری UDP
New-NetFirewallRule -DisplayName "RootInbox Rehearsal UDP" -Direction Inbound -LocalPort 3478 -Protocol UDP -Action Allow
```

---

## ۶. لاگ اختصاصی درخواست‌ها (`rehearsal.log`)

سرور در حالت مانور محلی تمامی درخواست‌ها را به صورت تک‌خطی و شفاف در کنسول و همچنین در فایل زیر ثبت می‌کند:
`scratch/lan_rehearsal/rehearsal.log`

نمونه لاگ ذخیره‌شده:
```text
[2026-11-06T07:12:00Z] 172.24.249.1:54120 GET / 200 2ms "Chrome on Windows"
[2026-11-06T07:12:01Z] 172.24.249.50:60234 POST /api/v1/auth/register 400 12ms "Mobile Safari on iOS" reason=AUTH_001_invalid_json
```
- در این لاگ هرگز محتوای پیام‌ها، رمز عبور، کلیدها یا توکن‌ها ثبت نمی‌شود.
- در صورت بروز هرگونه خطای ثبت‌نام یا لاگین، کد دلیل فنی استاندارد (`reason=...`) در پایان خط درج می‌شود.

---

## ۷. در صورت بروز هرگونه خطا چه مواردی را ارسال کنید؟

اگر در حین مانور با مشکلی مواجه شدید، ۳ قلم اطلاعات زیر را کپی کرده و برای بررسی ارسال نمایید:
1. **جدول خروجی خودآزمایی:** متن بخش `SELF-CHECK RESULTS` از ترمینال لپ‌تاپ.
2. **آخرین خطوط لاگ دسترسی سرور:** ۲۰ خط آخر فایل `scratch/lan_rehearsal/rehearsal.log`.
3. **گزارش صفحه بررسی دستگاه:** در گوشی یا لپ‌تاپ به صفحه `/device-check` رفته و دکمه **Copy Report** را بزنید و متن کپی‌شده را پیوست نمایید.
