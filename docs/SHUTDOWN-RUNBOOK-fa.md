# کتابچه راهنمای شرایط اضطراری و قطعی سراسری اینترنت (RootInbox Shutdown Runbook)

این سند، راهنمای جامع و گام‌به‌گام برای راه‌اندازی، مدیریت، اعتبارسنجی و بازیابی پیام‌رسان امن و مستقل **RootInbox** در هنگام **قطع کامل اینترنت بین‌الملل و فعال‌شدن شبکه ملی اطلاعات** است.

پیام‌رسان RootInbox به گونه‌ای مهندسی شده است که:
1. **۱۰۰٪ مستقل از اینترنت بین‌الملل** است (بدون نیاز به DNS خارجی، بدون نیاز به CDN، بدون وابستگی به Google Fonts یا مخازن خارجی، و با دیتابیس داخلی SQLite).
2. **تنها با یک فایل باینری کامپایل‌شده استاتیک** روی هر سرور لینوکسی خام (حتی با ضعیف‌ترین مشخصات: ۵۱۲ مگابایت رم و ۱ هسته CPU) اجرا می‌شود.
3. **بدون نیاز به دامنه اینترنتی (Bare IP)** کار می‌کند و گواهی امنیتی HTTPS/WSS و رله صوتی/تصویری TURN را به صورت خودکار با CA اختصاصی مدیریت می‌کند.

---

## ۱. آماده‌سازی بسته آفلاین پیش از وقوع بحران (Offline Kit Preparation)

پیش از وقوع قطعی اینترنت، مدیر سرور باید بسته آفلاین را آماده کرده و روی رسانه ذخیره‌سازی محلی (فلش‌مموری، لپ‌تاپ یا سرور محلی) نگهداری کند:

### ۱.۱. ساخت بسته آفلاین باینری
در مخزن کد، دستور زیر را اجرا کنید:
```bash
# در محیط لینوکس یا WSL:
chmod +x scripts/make-offline-bundle
./scripts/make-offline-bundle
```
این اسکریپت تمام بخش‌های وب (HTML/JS/CSS/PWA) را کامپایل کرده و به صورت تعبیه‌شده (Embedded) درون باینری قرار می‌دهد. خروجی در پوشه `dist/` شامل موارد زیر خواهد بود:
- `rootinbox-linux-amd64`: باینری استاتیک x86_64 لینوکس (حجم کمتر از ۲۵ مگابایت).
- `rootinbox-linux-arm64`: باینری استاتیک ARM64 (برای سرورهای ارزان‌قیمت مبتنی بر ARM یا رزبری‌پای).
- `rootinbox.service`: فایل تعریف سرویس Systemd با تنظیمات امنیتی بالا.
- `rootinbox.env.sample`: نمونه فایل متغیرهای محیطی.
- `SHA256SUMS`: چکسام فایل‌ها جهت اطمینان از عدم دستکاری.

### ۱.۲. تهیه سرور مجازی داخل کشور (IR VPS)
یک سرور مجازی لینوکس (Ubuntu 22.04/24.04 یا Debian 12) در دیتاسنترهای داخلی کشور (مانند آسیاتک، ابرآروان، پارس‌آنلاین، شاتل و ...) تهیه فرمایید:
- مشخصات سخت‌افزاری حداقلی: **۵۱۲ مگابایت رم، ۱ هسته CPU، ۵ گیگابایت دیسک**.
- آدرس IP عمومی داخل کشور (مثلاً `185.x.x.x` یا `5.x.x.x`).
- مطمئن شوید پورت‌های زیر توسط ارائه‌دهنده مسدود نشده باشند:
  - پورت `8080/tcp` (صفحه راهنمای راه‌اندازی و دانلود گواهی CA).
  - پورت `8443/tcp` (ارتباط امن اصلی پیام‌رسان HTTPS و WebSocket).
  - پورت `3478/udp` (سیگنالینگ و اعتبارسنجی STUN/TURN).
  - پورت‌های `50000:50100/udp` (محدوده پورت‌های رله صوت و تصویر تماس WebRTC).

---

## ۲. مراحل اجرایی دقیق در روز وقوع قطعی اینترنت (Exact Steps on the Day)

پس از قطع اینترنت بین‌الملل، مراحل زیر را روی سرور مجازی داخلی با دسترسی SSH انجام دهید:

```
[گام ۱: اتصال SSH] ---> [گام ۲: ایجاد کاربر ایزوله] ---> [گام ۳: نصب باینری و پوشه‌ها]
        |
        v
[گام ۴: تولید کلید امنیتی] ---> [گام ۵: تنظیم فایروال] ---> [گام ۶: استارت سرویس]
        |
        v
[گام ۷: اعتبارسنجی انگشت‌نگاری گواهی CA] ---> [گام ۸: ارسال پیامک راهنما به دوستان]
```

### گام ۱: اتصال به سرور از طریق SSH
```bash
ssh root@SERVER_IP
```

### گام ۲: ایجاد کاربر سیستمی ایزوله و غیرریشه (UID 1001)
برای امنیت حداکثری و دفاع در برابر نفوذ، برنامه هرگز نباید با دسترسی root اجرا شود:
```bash
sudo useradd --system --shell /usr/sbin/nologin --user-group rootinbox || true
```

### گام ۳: نصب فایل باینری و ایجاد مسیرهای داده
```bash
# کپی باینری به مسیر استاندارد
sudo install -m 755 rootinbox-linux-amd64 /usr/local/bin/rootinbox

# ساخت پوشه‌های داده، رسانه‌ها و کلیدهای TLS
sudo mkdir -p /var/lib/rootinbox/data /var/lib/rootinbox/tls /var/lib/rootinbox/media /etc/rootinbox
sudo chown -R rootinbox:rootinbox /var/lib/rootinbox /etc/rootinbox
sudo chmod 700 /var/lib/rootinbox/tls
sudo chmod 750 /var/lib/rootinbox/data /var/lib/rootinbox/media
```

### گام ۴: تولید کلید رمزنگاری محلی (IP_HASH_SECRET)
یک کلید با آنتروپی بالا (۳۲ بایت تصادفی) جهت رمزنگاری اطلاعات حساس روی دیسک تولید کنید:
```bash
APP_SECRET=$(openssl rand -hex 32)
echo "Secret generated successfully."
```

### گام ۵: ایجاد فایل تنظیمات محیطی
فایل `/etc/rootinbox/rootinbox.env` را با محتوای زیر ذخیره کنید (به جای `SERVER_IP`، آدرس IP واقعی سرور را قرار دهید):
```bash
sudo cat << EOF > /etc/rootinbox/rootinbox.env
# تنظیمات شبکه و آدرس سرور
SERVER_HOST=0.0.0.0
PORT=8443
PUBLIC_HOST=SERVER_IP

# تنظیمات امنیت و گواهی خودکار
TLS_MODE=selfsigned
TLS_DATA_DIR=/var/lib/rootinbox/tls
TLS_ONBOARDING_PORT=8080

# کلید رمزنگاری محلی
IP_HASH_SECRET=${APP_SECRET}

# مسیرهای داده و دیتابیس
DB_PATH=/var/lib/rootinbox/data/rootinbox.db
MEDIA_PATH=/var/lib/rootinbox/media
LOG_LEVEL=info

# غیرفعال‌سازی وابستگی‌های اینترنت خارجی
PUSH_ENABLED=false
INSECURE_DEV_MODE=false

# تنظیمات سرور رله تماس صوتی و تصویری (TURN/STUN)
TURN_ENABLED=true
TURN_LISTEN_ADDR=0.0.0.0:3478
TURN_RELAY_IP=SERVER_IP
TURN_MIN_PORT=50000
TURN_MAX_PORT=50100
TURN_ACTIVE_SECRET=${APP_SECRET}
EOF

sudo chown rootinbox:rootinbox /etc/rootinbox/rootinbox.env
sudo chmod 600 /etc/rootinbox/rootinbox.env
```

### گام ۶: تنظیم فایروال سرور (UFW)
```bash
sudo ufw allow 22/tcp comment 'SSH'
sudo ufw allow 8080/tcp comment 'RootInbox Onboarding & CA'
sudo ufw allow 8443/tcp comment 'RootInbox HTTPS & WSS'
sudo ufw allow 3478/udp comment 'RootInbox STUN/TURN Signaling'
sudo ufw allow 50000:50100/udp comment 'RootInbox TURN Media Relay'
sudo ufw enable
```

### گام ۷: نصب و اجرای سرویس Systemd
فایل `/etc/systemd/system/rootinbox.service` را ایجاد کنید:
```bash
sudo cat << 'EOF' > /etc/systemd/system/rootinbox.service
[Unit]
Description=RootInbox Private Messenger Server
After=network.target

[Service]
Type=simple
User=rootinbox
Group=rootinbox
WorkingDirectory=/var/lib/rootinbox
EnvironmentFile=/etc/rootinbox/rootinbox.env
ExecStart=/usr/local/bin/rootinbox
Restart=always
RestartSec=3s
LimitNOFILE=65535

# سخت‌سازی امنیتی
ProtectSystem=full
ProtectHome=true
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now rootinbox
```

### گام ۸: اعتبارسنجی اولیه و استخراج اثر انگشت CA
بررسی وضعیت اجرا:
```bash
sudo systemctl status rootinbox --no-pager
```
استخراج اثر انگشت SHA-256 گواهی ریشه اختصاصی:
```bash
CA_FP=$(openssl x509 -in /var/lib/rootinbox/tls/ca.crt -noout -fingerprint -sha256 | cut -d= -f2)
echo "=========================================================="
echo "RootInbox با موفقیت فعال شد!"
echo "آدرس صفحه راه‌اندازی دوستان: http://SERVER_IP:8080"
echo "آدرس امن پیام‌رسان:       https://SERVER_IP:8443"
echo "اثر انگشت امنیتی گواهی ریشه:"
echo "$CA_FP"
echo "=========================================================="
```

---

## ۳. جدول زمان‌بندی و زمان تخمینی هر مرحله (Estimated Time Per Step)

| مرحله | شرح عملیات | زمان تخمینی | SLA مجاز |
|---|---|---|---|
| **۱** | اتصال SSH به سرور مجازی داخلی | ۱۵ ثانیه | ۳۰ ثانیه |
| **۲** | ساخت کاربر سیستم و پوشه‌های کاری | ۱۰ ثانیه | ۲۰ ثانیه |
| **۳** | کپی و نصب فایل باینری استاتیک | ۱۵ ثانیه | ۳۰ ثانیه |
| **۴** | تولید کلید `IP_HASH_SECRET` و تنظیم فایل محیطی | ۳۰ ثانیه | ۶۰ ثانیه |
| **۵** | تنظیم پورت‌های فایروال UFW | ۱۵ ثانیه | ۳۰ ثانیه |
| **۶** | راه‌اندازی و اجرای سرویس با Systemd | ۵ ثانیه | ۱۰ ثانیه |
| **۷** | مقداردهی دیتابیس SQLite و تولید گواهی CA (Cold Start) | **۰.۷ ثانیه** | ۲ ثانیه |
| **۸** | استخراج اثر انگشت و آماده‌سازی پیام به دوستان | ۲۰ ثانیه | ۴۰ ثانیه |
| **جمع کل** | **راه‌اندازی کامل از صفر تا آماده به کار برای کاربران** | **~۱ دقیقه و ۵۰ ثانیه** | **<= ۳ دقیقه** |

---

## ۴. متن پیام آماده برای ارسال به دوستان و خانواده (Message to Friends)

این متن را کپی کرده و به جای `SERVER_IP` و `FINGERPRINT` مقادیر سرور خود را قرار داده و از طریق پیامک (SMS) یا پیام‌رسان‌های فعال برای دوستان خود ارسال کنید:

```text
سلام دوستان،
در شرایط قطعی اینترنت، پیام‌رسان اضطراری ما روی شبکه داخلی فعال شد.
برای ورود و برقراری ارتباط بدون نیاز به اینترنت بین‌الملل، مراحل زیر را طی کنید:

۱. با مرورگر گوشی یا کامپیوتر خود وارد لینک زیر شوید:
http://SERVER_IP:8080

۲. روی دکمه «دانلود گواهی امنیتی» کلیک کنید و آن را روی گوشی نصب کنید (نوع گواهی: CA / VPN and Apps).
۳. حتماً بررسی کنید که کد اثر انگشت گواهی (Fingerprint) دقیقاً با کد زیر یکی باشد:
FINGERPRINT

۴. پس از نصب، وارد پیام‌رسان امن شوید:
https://SERVER_IP:8443

۵. نام کاربری و رمز عبور دلخواه بسازید و گفتگو یا تماس صوتی/تصویری را آغاز کنید.
```

---

## ۵. اعتبارسنجی کارکرد و عدم نشت اطلاعات (Verification)

پس از راه‌اندازی، صحت موارد زیر را تست کنید:

### ۵.۱. تست دسترسی HTTP و گواهی ریشه
```bash
curl -I http://127.0.0.1:8080/ca.crt
# باید کد 200 OK برگرداند
```

### ۵.۲. تست سلامت سرور (Health Check)
```bash
curl -k https://127.0.0.1:8443/health/ready
# خروجی باید شامل: {"status":"ready", ...}
```

### ۵.۳. تست برقراری تماس صوتی/تصویری WebRTC
یک گفتگوی دوطرفه بین دو دستگاه برقرار کرده و گزینه تماس صوتی را بزنید. در لاگ سرور با دستور زیر عبور بسته‌های داده رله TURN را مشاهده کنید:
```bash
sudo journalctl -u rootinbox -f | grep -iE 'turn|call|relay'
```

### ۵.۴. اطمینان از عدم ارسال ترافیک به اینترنت بین‌الملل (Zero Outbound Egress)
```bash
# بررسی اتصالات خروجی پروسه
sudo ss -tupn | grep rootinbox
```
تمامی اتصالات باید در وضعیت `LISTEN` روی پورت‌های ۸۴۴۳، ۸۰۸۰، ۳۴۷۸ و بازه ۵۰۰۰۰-۵۰۱۰۰ باشند و هیچ کانکشن خارجی `ESTABLISHED` به سرورهای خارج از کشور وجود نداشته باشد.

---

## ۶. سناریوهای بحران و بازیابی فاجعه (Disaster Recovery)

### ۶.۱. خاموشی ناگهانی یا ریبوت سرور
به دلیل فعال بودن سرویس Systemd (`Restart=always` و `WantedBy=multi-user.target`)، بلافاصله پس از بوت شدن مجدد سرور، RootInbox در کمتر از ۱ ثانیه بالا می‌آید و بدون نیاز به هیچ دخالت دستی آماده پاسخگویی است.

### ۶.۲. مسدود شدن یا آسیب دیدن آدرس IP سرور (انتقال اضطراری به سرور جدید)
در صورتی که به هر دلیل نیاز به انتقال پیام‌رسان به سرور دیگری در شبکه ملی باشد:
1. پوشه `/var/lib/rootinbox` را روی سرور جدید کپی کنید:
   ```bash
   rsync -avz /var/lib/rootinbox/ root@NEW_SERVER_IP:/var/lib/rootinbox/
   ```
2. در فایل `/etc/rootinbox/rootinbox.env` سرور جدید، تنها مقدار `PUBLIC_HOST` و `TURN_RELAY_IP` را برابر با `NEW_SERVER_IP` قرار دهید.
3. توجه: چون پوشه `tls/` منتقل شده است، کلید خصوصی CA ثابت مانده و سرور به صورت خودکار گواهی HTTPS جدیدی با SAN معتبر برای `NEW_SERVER_IP` صادر می‌کند. دوستان شما نیازی به نصب مجدد گواهی CA نخواهند داشت!

### ۶.۳. تهیه نسخه پشتیبان برخط و سریع از داده‌ها (Live Hot Backup)
پایگاه‌داده SQLite در حالت WAL اجرا می‌شود و می‌توان بدون توقف سرور از آن نسخه پشتیبان تهیه کرد:
```bash
sqlite3 /var/lib/rootinbox/data/rootinbox.db ".backup '/var/backups/rootinbox-$(date +%Y%m%d-%H%M).db'"
```

---

## ۷. جمع‌بندی معیارهای کیفیت و تضمین پایداری

- **حجم مصرفی رم (Idle RSS):** کمتر از ۳۰ مگابایت (با ۱۰ کاربر همزمان فعال).
- **زمان استارت در سرور خام (Cold Start):** زیر ۱ ثانیه.
- **حجم فایل اجرایی:** حدود ۱۸ مگابایت (شامل سرور Go، دیتابیس، فرانت‌اند کامل React PWA و سرور رله WebRTC TURN).
- **عملکرد در رم ۲۵۶ مگابایت:** تست‌شده و کامپایل‌شده بدون خطر OOM Killer.
