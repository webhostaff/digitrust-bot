# DIGITRUST Bot — Upgrade Notes

Everything here is additive. No existing table is dropped or rewritten, and no
existing feature was removed. The migration runs automatically on boot from
`database/db.js` and is idempotent — restarting any number of times is safe.

---

## V146 — قبول التحويل الداخلي (Off-chain) + السعر المخصّص من كمية معيّنة

### 1) Binance Off-chain Transfer
**العطب**: التحويل من حساب بينانس لحساب بينانس ما عندو TxID بلوكتشين. بينانس يوريه كـ `Off-chain Transfer 418351948005`. اللصق اليدوي كان يرفضو بـ "Invalid TxID format" لأنو يستنى hash (64 حرف). (الإيداع **التلقائي** كان يقبلو أصلا.)
**توا**: الزبون ينجم يلصق **الرقم برك** (`418351948005`) ولا `Off-chain Transfer 418351948005` بأي شكل، في **شحن المحفظة** وفي **دفع طلب بـ USDT**.
- يتبحث عنو في سجل إيداعات حسابك. التحويل الداخلي ما فيهش شبكة وعنوان بلوكتشين، فما نفرضوهمش عليه (يخصّو فقط يكون USDT ومبلغو يطابق الحجز، ويخضع لنفس نافذة الوقت).
- **الحماية من الاستعمال المزدوج**: نفس التحويل يتحسب مستعمَل بأي شكل: `418351948005` = `Off-chain Transfer 418351948005` = `off-chain transfer: 418351948005`. وأي سجل قديم محفوظ بالصيغة الأخرى يتعرف عليه.
- الحجز يتلقّى على أي شبكة (BEP20/TRC20/TON) لأنو ما فما شبكة. غير صاحب الحجز يتشحن. مبلغ ما يطابق حجز ← مراجعة يدوية، ما يتشحنش لحدو.
- رسالة الخطأ وتعليمات الدفع ولّاو يذكرو الرقم هذا (عربي/انجليزي/فيتنامي/اسباني).

### 2) السعر المخصّص يبدا من كمية معيّنة
**العطب**: العمود `min_qty` موجود في قاعدة البيانات لكن **ما ينقرأش**: السعر المخصّص يتطبّق من أول وحدة، وما فما حتى طريقة تحطّ الكمية الدنيا ولا تبدّل سعر موجود.
**توا**:
- في إدخال السعر: **`x20`** = السعر يبدا من 20 وحدة (أقل من هكا يدفع السعر العادي)، **`q100`** = السعر يغطي 100 وحدة في المجموع. مثال: `3.50 x20 q100 جملة`.
- الشراء يطبّق الكمية الدنيا فعلا، وكان عندو شرائح (من 10: 7$، من 50: 5$) الأعلى المستوفاة تتطبّق. تحت الحد الأدنى: السعر العادي (بما فيه أسعار الجملة متاع المنتج).
- **✏️ تعديل** قدّام كل سعر مخصّص (قبل كان حذف وإعادة إنشاء برك): اللي ما تذكرو يبقى كيما هو. `x30` برك يبدّل بداية الكمية، `2.90` برك يبدّل السعر، `q0` يشيل حد الوحدات، `-` في الآخر يمسح الملاحظة. تنجم تبدّل بداية شريحة لكن مش لشريحة موجودة قبل.
- الحريف يشوف في صفحة المنتج "Your special price: 6.00$ from 20 units" وفي ملخّص الطلب: "سعرك الخاص يتطبّق من 20 وحدة".
- الـ API للموزّعين: `special_price.min_quantity`.
- **القديم يبقى كيما هو**: سعر مخصّص بلا حد أدنى يتطبّق من أول وحدة.

---

## V145 — تعديل اشتراك مفعَّل + إعلام الزبون

**`/setdates <order> <أول يوم> <آخر يوم> [ملاحظة للزبون]`** يخدم توا على الاشتراك المفعَّل زادة.

على مقعد **مفعَّل** (الزبون يعرف تواريخو) البوت **ما يبدّل حتى شي قبل ما تأكّد**، ويورّيك:
- التواريخ الحالية والجديدة وعدد الأيام،
- **نفس الرسالة بالضبط الي باش توصل الزبون**،
- تحذير 🚨 كان التاريخ الجديد في الماضي (المقعد يولّي منتهي).
وتحتو 3 أزرار: **✅ طبّق وبلّغ الزبون** · **🔕 طبّق من غير ما تبلّغو** (لتصحيح غلطة ما لاحظها) · **❌ إلغاء**.

- **الملاحظة**: كل كلمة بعد التاريخين تتبعث للزبون (مثال: `/setdates 20439 2026-10-05 2026-11-05 تم نقل حسابك لبانل جديد`).
- الزبون يتبلّغ برسالة: "📅 Your subscription dates were updated" مع تاريخ الانتهاء الجديد (والقديم) وملاحظتك.
- **كان الزبون حاجب البوت**: التواريخ تتبدّل، ويقلك البوت "ما نجمتش نبعثلو، قلّو انت".
- كل ضغطة تخدم **مرة وحدة** (الضغط الثاني ما يعاودش يبعث)، وصالحة 15 دقيقة.
- **التذكيرات** بالانتهاء تتبع التاريخ الجديد وحدها، وعلامات "ذكّرتو" القديمة تتصفّر.
- **سجل** لكل تعديل (من، قبل، بعد، بلّغت ولا لا، الملاحظة) في جدول `cgb_date_edits`.
- البطاقة الخضراء تبقى خضراء وتولّي فيها سطر: "Dates changed on …: 2026-10-30 → 2026-11-05 — customer told"، وفيها زر **✏️ Change dates**.
- **ما يتبدّلش**: السعر الي دفعو، وحالة الاشتراك. المقعد **المنتهي** ما يتعدّلش (لازم تجديد)، ولا الملغى، ولا غير المدفوع.
- مقعد **غير مفعَّل** يتبدّل فورا كيما قبل، من غير تأكيد ومن غير إعلام الزبون.

---

## V144.2 — تجديد الدورة المحذوفة (5 ← 9 الشهر الجاي) + تسليم بلا أوسمة `<code>`

### 1) ChatGPT Business: التجديد
**العطب**: التجديد كان ياخذ نهايتو من "أحسن دورة لمشتري جديد اليوم" (تتبدّل كل ما تزيد دورة ولا تحذف وحدة). بعد حذف دورة، كل التجديدات ولّات تنتهي يوم 30: زبون مقعدو ينتهي 5 تجدّد 5 → 30 (25 يوم بسعر شهر كامل).

**القاعدة توا** (التجديد يتبع دورة الزبون):
- **مقعدو ينتهي في نهاية دورة موجودة** ← يتجدّد لنهايتها الجاية: دورة كاملة، السعر الشهري.
- **ما فما دورة تنتهي هناك** (دورتو تحذفت وتنقل لبانل دورة أخرى) ← التجديد يبدا بـ**الأيام الزايدة** لين أقرب نهاية دورة (بسعر نسبي لأيامها برك)، **وبعدها الشهر الكامل**. مثال: مقعد ينتهي 5 أكتوبر والدورة الجديدة تنتهي 9 ← يتجدّد **من 5 أكتوبر لـ 9 نوفمبر = 35 يوم**: 4 أيام (`4/29 × السعر الشهري` = 2.10$) + شهر كامل (15.20$) = **17.30$**. وبعدها مقعدو ينتهي 9 نوفمبر ويولّي عادي: التجديد الجاي 9 نوفمبر ← 9 ديسمبر بالسعر العادي.
  أشهر أكثر: الأيام الزايدة + الأشهر كاملة (شهرين: 5 أكتوبر ← 9 ديسمبر).
- مقعد منتهي، ولا نهاية يدوية ("Set exact end time") ← كيما قبل.
الزبون يشوف قبل ما يدفع الفترة والسعر وسطر يشرحلو علاش.

**للطلبات الي تخلصت بتواريخ غالطة** (مثل #20439):
- **`/checkrenewals`**: كل تجديد مدفوع ما تفعّلش: الغالط مع التواريخ الصحيحة، **المبلغ الي دفعو، السعر الصحيح، وقداش تردّلو** (↩ بـ ➕ Add User Balance) وأمر جاهز.
- **`/setdates <order> <أول يوم> <آخر يوم>`**: مثال `/setdates 20439 2026-10-05 2026-10-09`. يبدّل التواريخ ويعاود يرسم بطاقتك في نفس المكان. **السعر الي دفعو ما يتبدّلش**: الفرق تحاسبو انت.
- زر **✏️ Change dates** في البطاقة.
- ما يتبدّلش: مقعد تفعّل، ولا ملغى، ولا ما تخلصش.

### 2) التسليم: "CODE CODE"
**العطب**: العناصر تتخزّن بوسم `<code>` (من الي تنسخو)، والتسليم يزيد عليها `<code>` ثانية، وملف الـ .txt الي يتبعث للروابط الطويلة يتكتب بالأوسمة نفسها: `<code>https://…</code>` حرفيا.
**توا**:
- الملف يتبعث **نص عادي**: الروابط برك، واحد بعد واحد.
- المخزون يتخزّن **بلا** `<code>`/`<pre>` (حتى لو لصقتو بيهم). والمخزون القديم الي فيه الوسم يتسلّم بوسم واحد (ما يتكرّرش).
- محتوى فيه `<` ولا `>` ولا `&` (كلمة سر مثلا) يتأمّن، تيليجرام كان يرفض الرسالة الكل.
- نفس الشي في "My Orders" وفي معاينات الأدمن والدعم.
- إصلاح صغير: رسالة "Referral Cashback: $NaN (undefined%)" الفارغة ما عادش تتبعث لما الطلب أقل من الحد الأدنى للكاشباك.

---

## V143 — 🎁 Referrals: إيقاف + أداة تتبع

**الأدمن ← 🎁 Referrals** (زر جديد في القائمة الرئيسية).

- **🔴 Turn the programme OFF**: يوقف **كل** أرباح الإحالات الجديدة: الكاشباك الدائم (2%)، ومكافأة أول شراء (0.20$)، وفتح VIP للمُحيل بعد 3 إحالات. **الي ما يتبدّلش**: الرصيد الي في المحافظ، والـ VIP الي تفتح قبل. روابط الإحالة الجديدة تبقى تتسجّل باش تكمل التتبّع. وكي يفتح الحريف شاشة الإحالة يلقاها تقول "غير متاحة حاليا" (ما فيهاش رابط ولا وعود).
- **🚫 Block his referral earnings**: تحجب شخص واحد برك، والبرنامج يبقى يخدم لغيرو. ما يتلمسش رصيدو.
- **🏆 Who earns most**: ترتيب المُحيلين بالأرباح، وعدد الي أحالهم وكم منهم اشترى. 🚩 على الي فيه علامة تحذير.
- **تفاصيل كل شخص**: كم ربح، كم رصيدو الآن، كل حساب أحالو (كم طلب، كم صرف، **وكم أعطاه**)، آخر العمولات، وعلامات التحذير:
  - 🚩 5 حسابات أو أكثر تصنعوا في أقل من ساعة.
  - ⚡ أغلب الي اشتروا اشتروا في أقل من 10 دقايق من الانضمام.
  - 🟰 كل المشترين صرفوا نفس المبلغ بالضبط.
  هذي **علامات للفحص مش دليل**.
- **📄 Export CSV**: كل العمولات (التاريخ، المُحيل، المُحال، الطلب، المبلغ).
- لسحب حريف: ادفعلو يدويا ثم **➖ Remove User Balance** (فيه اختصار في شاشة الشخص).

---

## V142.1 — بوت الدعم: كل طلبات الحريف (صفحات)

- **الي صار**: زر "📦 Their orders" كان يوريك آخر 20 طلب برك ويكتب "…and 57 more" من غير ما تنجم تشوف الباقي، وهذا بالضبط الوقت الي تحتاج فيه الطلبات القديمة (refund، "ما وصلنيش طلب #15329").
- **توا**: كل 20 طلب في صفحة، وتحت أزرار **◀ Newer / 2/4 / Older ▶** و **⏮ Newest / ⏭ Oldest**. فوق القائمة: عدد الطلبات، ومجموع الي تسلّم، والصفحة (مثلا "orders 21–40 of 77").
- كل حالة ليها أيقونتها: ✅ تسلّم · ⏳ معلّق · ❌ ملغى · 🕐 ينتظر التسليم · 💳 ينتظر الدفع · ↩️ مسترجع.
- عنوان المنتج يتأمّن (ما يكسرش الرسالة كان فيه رموز HTML).

---

## V142 — منتجات بلا خصم VIP

- **زر جديد في تعديل أي منتج: 👑 VIP Discount**. كي تفعّل "Remove the VIP discount here"، الـ VIP والحرفاء الي عندهم رتبة **يشريو المنتج هذا بسعرو العادي**. وتنجم ترجّعو بنفس الزر.
- يتبيّن في شاشة تعديل المنتج: `👑 VIP discount: ✅ Applies` ولا `🚫 Not applied`.
- **الي ما يتبدّلش**: أسعار الجملة (Bulk) تبقى لكل الناس (هي قائمة أسعار المنتج). والسعر الي تحطو لحريف واحد تبقى كيف ما هي.
- **الحريف** يشوف في ملخّص الطلب سطر: "Your 5% VIP discount does not apply to this product — it is sold at its normal price" (باش ما يسألش وين خصمي). الي ما عندوش خصم ما يشوفش السطر.
- يخدم في الشراء العادي وفي الطلب المسبق (Pre-order).
- يمان يعرف: `products_list` ولّى فيه `vip_discount: false` للمنتجات هذي، فما يوعدش بخصم عليها.
- المنتجات الحالية كلها تبقى كيف ما هي (الخصم يخدم) حتى تبدّلها انت.

---

## V141 — حتى 8 شرائح لأسعار الجملة

- كل منتج ولّى عندو **8 شرائح** (Tier 1 … Tier 8) بلاصة 4. شاشة Bulk Pricing تورّي الشرائح الي مضبوطة وزر **➕ Add Tier N** واحد للشريحة الجاية.
- كل الأسعار الي حطيتها قبل ما تتبدّل (تجرّبت على داتابيز بنسخة V140). الأعمدة الجداد تتزاد وحدها كي يقوم البوت.
- الحريف يشوف كل الدرجات: `2000 – 2499 … / 2500 – 2999 … / 5000+ 🔥`.
- شاشة الأدمن:
  - ترتيب الشرائح لازم يبقى سعر ينقص كي الكمية تزيد (نفس القاعدة).
  - تحذير ⚠️ كان الشريحة كميتها أكبر من حد الطلب (2000)، خاطر ما أحد يقدر يوصلها.
  - مثال "شنو يدفع الحريف" يورّي بداية كل شريحة.
- العدد الأقصى مكتوب في مكان واحد: `utils/bulkTiers.js` (`MAX_BULK_TIERS`). كان تحب أكثر من 8، بدّل الرقم هذاكا وقت التحديث الجاي.

---

## V140 — حد الطلب 2000 + شريحة رابعة للأسعار

- **الحد الأقصى للطلب الواحد**: من 500 لـ **2000**. القيمة تتخزّن في الداتابيز (`max_qty_per_order`)، فالتحديث ينقلها مرة وحدة من 500 لـ 2000. كان انت بدّلتها بيدك لرقم آخر (ولا 0 = بلا حد) ما تتمسّش.
- **شريحة رابعة** في Bulk Pricing: من الأدمن ← المنتج ← Bulk Pricing ← **➕ Add Tier 4**. اكتب الكمية والسعر، مثلا `2000 0.40`. كان تخلّيها فارغة، كل شي يخدم كيف قبل.
- الشريحة الرابعة تدخل في الحساب، وفي العرض للحريف (`1500 – 1999 … / 2000+ … 🔥`)، وفي تغيير السعر الأساسي (تتناسب معاه).
- ما تبدّلش: حد الـ API العامة (100 في الطلب) وحد API الموزّعين (50 في الطلب).

---

## V139 — تجديد روابط Gemini خرج من البوت

- بطلب المالك، التجديد ولّى في تطبيق منفصل على Vercel (`diginest-vercel-fast`)، وتنحّى من البوت الكود الي تزاد في V137 (`services/geminiRefresh.js` والتغييرات في التسليم).
- البوت يسلّم الروابط كيف ما هي في المخزون، كيف قبل V137. `GVL_AUTH` ما يلزمش في Railway، وكان زدتو تنجم تفسخو.
- الإضافة للمخزون بملف .txt (V138) مازالت تخدم.
- مع التطبيق تنجم:
  - تجدّد الروابط فيه وترفع `refreshed-links.txt` للبوت بملف.
  - ولا تحط في المخزون "روابط الحريف" (Direct customer links) الي تتجدّد كي يحلّها الحريف.

---

## V138 — إضافة المخزون بملف .txt

- في **Large Stock Upload** (وزادة الإضافة العادية للمخزون) تنجم تبعث **ملف .txt** حتى 20 MB.
- كان الملف فيه `AYMEN` يتقسّم عليها كيف العادة، وإلا **كل سطر عنصر**، وهذا يناسب روابط Gemini.
- الـ `message.txt` الي يعملو Telegram Desktop كي تلصق نص طويل يخدم مباشرة.
- البوت يقلك قداش من عنصر قرا ويورّيك الأول، ومبعد اكتب `DONE` كيف العادة.
- جرّبتها: 3000 رابط (1 MB) تحفظو في 25 ms.

---

## V137 — تجديد روابط Gemini في الخلفية

- كل رابط `serviceactivation.google.com/subscription/new/...` في أي طلب يتجدّد عند المورّد **لحظة التسليم**، والحريف يستلم الرابط الجديد كرابط عادي.
- يخدم في كل طرق التسليم: الشراء بالرصيد، TxID / Binance، CryptoBot، تسليم الطلبات المسبقة، API v2، وAPI الموزّعين v1.
- الكميات الكبيرة: 6 روابط في نفس الوقت، وأقصى حد 90 في الدقيقة (حد المورّد 100).
- رابط ما تجدّدش (المورّد ما يعرفوش، ولا عطل): يتسلّم كيف ما هو ويوصلك تنبيه برقم الطلب.
- سجلّ الطلب ("طلباتي") يحفظ الرابط الجديد.
- المنتجات الأخرى ما يتمسّهاش.

**لازم**: زيد في Railway → Variables:
`GVL_AUTH` = قيمة `auth` متاع المورّد

(اختياري: `GVL_PER_MINUTE` و `GVL_CONCURRENCY`.) بلا `GVL_AUTH` الروابط تتسلّم كيف ما هي، كيف قبل.

---

## V136 — مبلغ الإيداع بزوز أصفار

- المبلغ ولّى يجي هكا: `10.001` لين `10.009`، يعني الزيادة أقل من سنتيم.
- كان التسعة محجوزين في نفس الوقت: `10.0011` لين `10.0099`، وفيه زادة زوز أصفار.
- ونادراً: `10.011` لين `10.099`.
- ما فماش ثلاثة أصفار كيف `29.000350`.
- الرسالة متاع الحريف ولات تقول إنو الزيادة أقل من سنتيم وتتزاد كاملة لرصيدو.

---

## V135 — زيادة صغيرة في مبلغ الإيداع

- الزيادة الي تتحط باش نعرفو الإيداع ولات أقل من 10 سنتيمات في الحالات العادية:
  1. `10.01` لين `10.09`
  2. كان التسعة محجوزين في نفس اللحظة: `10.011` لين `10.099`
  3. ونادراً برشا: `10.101` لين `10.999`
- قبل كانت توصل لـ `10.27`. والزيادة ديما تتزاد كاملة لرصيد الحريف.
- كل شبكة عندها الأرقام متاعها، وما ينجمش زوز حجوزات مفتوحين يكون عندهم نفس المبلغ.

---

## V134 — تصليح الليستات الطويلة

- في V133، كي تكون المحادثات برشا (الخاص ولا الدعم)، الصفوف كانت تدخل في بعضها وما تتقراش، والضغطة تطيح على الصف الي بحذاه.
- توا الصفوف ما تنكمشش مهما كان العدد، والليستة تتحرّك (scroll) عادي. الحجم المصغّر متاع V133 ما تبدّلش.
- جرّبتها بـ 100 محادثة دعم و 40 محادثة خاصة.

---

## V133 — تطبيق يمان أصغر ويجي على قد الشاشة

- الصفوف في الخاص والدعم ولاو أصغر (~46px بلاصة ~64px)، يعني تبان محادثات أكثر في الشاشة.
- الدوائر (الحرف الأول) والأيقونات تصغّرو، والعنوان وشريط الكتابة ولاو أخف.
- الأحجام تتبدّل حسب عرض الشاشة، وتصغر زادة في التليفونات الضيقة (أقل من 380px).
- كل الميزات كيف ما هوما، بدّلت الأحجام برك.

---

## V132 — مزامنة الإيداعات اللحظية · يمان يعرف شنوة أكّدت · ألوان

- **مبلغ الإيداع بزوز أرقام** (`29.37` بلاصة `29.000350`). السنتيمات تتزاد كاملة للحريف.
- **مزامنة لحظية**: كل 40 ثانية (`DEPOSIT_SCAN_SECONDS`) البوت يقرا Binance ويزيد المبلغ المحجوز وحدو، بلا TxID. يغطّي TON (الـ hash يختلف ديما) والتحويلات الداخلية Off-chain. نفس القواعد: الحجز لازم يكون متاع الحريف وقبل التحويل، وما يتزاد شي مرتين.
- **تصليح TON**: الـ fallback بالمبلغ ولّى يشوف كان حجوزات الحريف نفسو، ما عادش يتّهم حريف بريء بإنو "يسرق".
- **يمان**:
  - يوصلو شنوة أكّدت بالأزرار قبل رسالتك الجاية.
  - يرفض يحضّر نفس الإضافة مرتين.
  - يثبّت الـ TxID قبل ما يتبعث للموديل.
  - عندو `system_guide` يشرح السيستام الكل.
- **تنبيهات قصيرة**: الحوايج المتشابهة تتجمّع في سطر واحد، وأقصى حد 5 أسطر.
- **ألوان** في الخاص والدعم: 🔴 ما تقراوش ← 🟢 جاوبت ← 🟡 قريتهم وما جاوبتش.

---

## V131 — يمان يربط الأحداث · قسم الدعم · المحادثات المشاهدة

- **ذاكرة يمان**: كل رد يتحفظ معاه شنوة عمل (الأداة، الحريف، النتيجة)، ويتذكّر الحريف الي يخدم عليه 45 دقيقة. "ومساج" / "زيدو" بلا اسم = نفس الحريف. حد قطع المحادثة طلع من 12k لـ 24k.
- **ما عادش يرد فارغ**: كان عمل عملية وما كتب شي، يكتب وحدو شنوة عمل.
- **التصليح**: "شبيك"، "بهيم"، "ما فهمتش"… ← يمان يعرف إنك تصلّحلو، يصلّح ويحفظ قاعدة. التعلّم الليلي يقرا العمليات والتصليحات.
- **الإيداعات**: الإيداع المتحقق منه في Binance يتحضّر بمبلغو الحقيقي في مسودة وحدة (حتى `AGENT_VERIFIED_CREDIT_CAP`، افتراضياً $500). ما عادش $0.01، وما عادش "$20 والباقي من /admin". الـTxID يتسجّل كي تأكّد، وما يتزادش مرتين.
- **المحادثات الخاصة**: الجديدة فوق، الي جاوبت عليهم في الوسط، والي شفتهم لوطة بـ 👁 (في التطبيق برك، الشخص ما يشوفش ✓✓). رسالة جديدة ترجّعها فوق، ويمان ما ينبّهكش على محادثة شفتها.
- **قسم «رسائل الدعم»**: محادثات بوت الدعم، تجاوب منها (الرد يخرج من بوت الدعم)، ✨ اقتراح، و«يمان يتكفّل» يحضّر كل شي ويستنى موافقتك.
- **زر الإرسال على اليمين.**

جدول جديد واحد (`business_seen`) يتصنع وحدو. متغيّر اختياري: `AGENT_VERIFIED_CREDIT_CAP`.

---

## ⚠️ Before you deploy

| Item | Why it matters |
|---|---|
| Add the `ADMIN_ID` variable | Your numeric Telegram id. Used by the support bot, the ChatGPT bot and admin pushes. Without it the code falls back to a hard-coded id. |
| `DB_PATH` must point at a Railway **Volume** | Otherwise SQLite is wiped on every deploy and everything below is lost with it. |
| Set `deposit_cutoff_ms` to "now" | Blocks every historical TxID immediately — see the security section. |

`ADMIN_ID` is the only new environment variable. Everything else is configured
inside the bot under `/admin → ⚙️ Settings`.

---

# Part 1 — Support bot

## What was wrong

`support-bot.js` sent `"✅ Your message has been sent"` at the end of every
single `bot.on('message')` with no condition, so the customer got it after each
message. `is_read` existed in the table but was only used to count unread
threads for the admin — nothing was ever shown to the customer. And `showChat`
replayed only the last 15 messages via `messages.slice(-15)`, with no way to go
further back.

## What changed

* The per-message auto-reply is gone. The welcome is sent **once per customer
  ever**, latched in `support_threads.welcomed`.
* Read receipts. The customer sees a single status line:
  * `✓ Sent` — stored, support has not opened it
  * `✓✓ Read by support · HH:MM` — a staff member actually opened the chat

  The line is **edited in place**, so ten messages produce one indicator rather
  than ten. State lives in `support_threads` plus
  `support_messages.is_read` / `read_at`, so it is still correct after a restart.
* Full history: pagination (`⬆️ Older` / `⬇️ Newer`), date separators, a
  timestamp on every message, and a clear 📩 Customer / 📤 Support split.
* Attachments can be replayed per page.
* Customer search, and a `📦 Their orders` shortcut inside the chat.
* Staff is now anyone in `ADMIN_IDS`, not only `ADMIN_ID`.

---

# Part 2 — Refund eligibility

## What was wrong

There was no eligibility field at all. `refund_request_start` filtered only on
`status === 'delivered'`, so every delivered order could be refunded.

## What changed

* `Edit Product → 🔄 Refund Eligibility` toggles a product.
* Non-eligible products are filtered out of the customer's refund list.
* Eligibility is re-checked **server-side three times**: when listing, when the
  request is opened, and again at final submit. A forged callback is rejected
  with a clear message.
* The product page warns the buyer *before* purchase when refunds are
  unavailable.

New column: `products.refund_enabled` (default `1`, so nothing changes until you
opt a product out).

---

# Part 3 — Order history

## What was wrong

`ordersListKb` did `orders.slice(0, 10)`. A customer with more than ten orders
simply never saw the older ones — this is the "some products don't appear" issue.

## What changed

* The cap is gone; nothing is hidden.
* Pagination (8 per page) plus date filters: **All / 7 days / 30 days / This
  month / Last month**.
* The header shows "Showing X of Y total" so the customer can see the list is
  complete.
* Manual-delivery orders show their live stage (🕐 waiting, ⚙️ in progress).

---

# Part 4 — Manual delivery

## What was wrong

Every purchase went through `deliverOrder`, which consumes stock immediately.
There was no alternative path for products you hand over yourself.

## What changed

New column `products.delivery_type` (`'auto'` | `'manual'`), toggled from
`Edit Product → 🚚 Delivery Method`.

For a manual product, on successful payment the order becomes
`awaiting_delivery`, **stock items are not consumed**, and a task is opened in
`manual_deliveries`.

Guarantees, and where they come from:

| Guarantee | Mechanism |
|---|---|
| Never created before payment succeeds | the task is opened only after the atomic charge/settle transaction returns `ok` |
| Never duplicated for one order | `UNIQUE(order_id)` + `INSERT OR IGNORE` |
| Never disappears before it is done | it is a database row, not a message |
| No repeated admin pings | `notifyAdmin` dedupe key + `notified_at` latch |

Works on all four payment paths: wallet, USDT, Binance Pay, CryptoBot.
Statuses: `pending → processing → delivered`, plus `cancelled` (cancelling
refunds the wallet automatically).

---

# Part 5 — Manual delivery panel

Available in **both** places, with identical data:

* Support bot: `/manual` or the 📦 button in the inbox
* Admin panel: `/admin → 📦 Manual Delivery`

Status tabs with counters, a 🆕 badge on unreviewed tasks, newest-first ordering,
search (order no. / task id / customer / product / email), and per-task actions.

---

# Part 6 — Stock alerts

## What was wrong

`checkAndNotifyStockLevel` published to the public channel only. Nothing reached
the admin, there was no duplicate protection, and no configurable threshold.

## What changed

* Fires at **0** (sold out) and at the **low threshold**.
* Threshold is per product (`products.low_stock_threshold`), falling back to the
  global `low_stock_threshold_default` setting.
* Latching via `oos_notified` / `low_notified`: sell out → **one** alert; stays
  at zero → silence; restock and sell out again → a **new** alert.
* Hooked into every stock mutation: purchases and all six admin stock actions.
* The alert carries product name, id, price, remaining stock, timestamp, and a
  button that jumps straight to stock management.

---

# Part 7 — Admin notification centre

`/admin → 🔔 Notifications`

* Types: manual delivery, out of stock, low stock, refund request, support message.
* Unread / All tabs, unread counter, pagination, mark-all-as-read.
* Opening a notification marks it read and offers a deep link to the related
  task / request / product.
* Also pushed to `ADMIN_IDS`, `ADMIN_ID` and the optional `admin_notify_chat_id`
  channel.
* **Duplicate protection**: `dedupe_key` is `UNIQUE` and the insert is
  `INSERT OR IGNORE`, so the same event is stored exactly once no matter how many
  times the producing code path runs.

---

# Part 8 — Deposit security (critical)

## The vulnerability

The USDT deposit address is a **single shared address**. Every transfer to it is
public on BscScan / Tronscan — TxID, amount and timestamp included. The old code
treated "knows the TxID" as proof of ownership, which is not authentication at
all: anyone could read the explorer and claim any transfer nobody had claimed yet.

Confirmed in production on 2026-08-05:

```
[VERIFY] MATCH FOUND: amount=1117.7303 ... insertTime=1783860551000
Top-up credited: user=354712964 amount=1117.7303 method=USDT BEP20
```

`insertTime` corresponds to roughly 12 July — a **24-day-old** transfer, claimed
on 5 August. The same flaw explains the user whose BEP20 deposit "never
arrived": somebody else submitted their TxID first, so the real owner's attempt
hit the already-used guard.

## The fix — amount reservation

1. Pick network → 2. enter amount → 3. the bot reserves a **unique** figure
(e.g. `10.004731`) → 4. send exactly that → 5. submit the TxID.

A deposit is matched by **(network + exact amount + time window)**, not by who
types the TxID first. The TxID is now only used to look the transfer up.

### Checks applied, in order

| # | Check | Stops |
|---|---|---|
| 1 | TxID never used before | replay |
| 2 | Binance confirms status=1, USDT, our address | fake claims |
| 3 | Age within `deposit_max_age_minutes` | harvested old TxIDs ← the $1117 attack |
| 4 | Timestamp not in the future | clock manipulation |
| 5 | Amount matches a live reservation | random guessing |
| 6 | Reservation belongs to the submitter | front-running |
| 7 | Transfer post-dates the reservation | back-dating |
| 8 | Reservation consumed atomically | double-claim |

### Timers

| Setting | Value | What it measures |
|---|---|---|
| `deposit_max_age_minutes` | **15 min** | Age of the on-chain transfer when the TxID is submitted. This is the security control. |
| `deposit_intent_ttl_minutes` | **30 min** | How long a reserved amount is held before the transfer must be made. |
| `deposit_strict_mode` | `1` | **Keep at 1.** `0` restores the old, exploitable behaviour. |
| `deposit_cutoff_ms` | existing | Global hard floor — set it to "now" during an incident. |
| `PAYMENT_CONFIRM_VALIDITY_MIN` | 20 min | Unrelated: the order-payment session window in `utils/format.js`. |

### Why 15 minutes does not hurt honest users

From the production log, honest deposits are claimed 1–2 minutes after arrival
(the user is inside the flow), and Binance moves a deposit from status 0 to 1 in
5–46 seconds. 15 minutes leaves wide margin.

More importantly, `services/binance.js` **soft-fails** a late transfer
(`found: true, tooOld: true`) and lets `handlers/wallet.js` decide, because the
right answer depends on the reservation:

| Situation | Outcome |
|---|---|
| Late + valid reservation owned by the submitter | → manual review, credited by admin |
| Late + no reservation | → **hard refused**, never queued (the harvesting attack) |
| Late + reservation owned by someone else | → refused, logged as a theft attempt |

So the window can be tightened aggressively: legitimate failures degrade to a
manual approval, while the attack path is closed outright.

### Admin tools

* `🛡 Deposit Review` — pending / approved / rejected tabs. Approving credits the
  rightful user and records the TxID as used, so it can never be claimed twice.
* `↩️ Reverse a deposit` — `USER_ID AMOUNT [reason]`. The balance is allowed to
  go negative on purpose: if the thief already spent the money, the debt stays
  visible instead of silently vanishing. Written to `balance_reversals`.

---

# Part 9 — Fraud response

`/admin → 👥 Users → [user] → 🚨 Fraud: cancel all orders`

Shows a preview first, then two choices: cancel **without** refund (the default
for fraud) or cancel **with** refund.

In one transaction it:

* cancels every `pending` and `awaiting_delivery` order
* closes the attached manual-delivery tasks
* **returns the stock** and corrects `sold_count` / `sales_count` — otherwise a
  fraud wave silently destroys the inventory numbers
* **rejects the user's pending refund requests**, so stolen credit cannot be
  cashed out to an external wallet
* releases their open deposit reservations
* leaves `delivered` orders untouched and reports the count — those goods are
  gone and rewriting history would corrupt the accounting

---

# Database changes

## New columns on `products`

| Column | Default | Meaning |
|---|---|---|
| `refund_enabled` | `1` | `1` = refunds allowed, `0` = blocked |
| `delivery_type` | `'auto'` | `'auto'` = instant, `'manual'` = opens a task |
| `low_stock_threshold` | `0` | Per-product alert level; `0` uses the global default |
| `oos_notified` / `low_notified` | `0` | Latch flags; cleared automatically on restock |

## New column on `support_messages`

`read_at` — the exact moment support opened the message.

## New tables

| Table | Purpose |
|---|---|
| `support_threads` | ✓/✓✓ indicator state and the one-time welcome latch |
| `manual_deliveries` | Manual delivery tasks. `UNIQUE(order_id)` prevents duplicates |
| `admin_notifications` | Persistent admin inbox. `UNIQUE(dedupe_key)` prevents duplicates |
| `deposit_intents` | Amount reservations, with a partial UNIQUE index on open rows |
| `deposit_reviews` | Deposits held for manual approval |
| `balance_reversals` | Audit log of every reversal |

`orders.status` gains one new value: **`awaiting_delivery`** (paid, waiting on a
human). Existing statuses are untouched.

---

# Pre-existing bugs fixed along the way

| Bug | Impact | Fix |
|---|---|---|
| `logger` used but never required in `handlers/start.js` | `ReferenceError` 15+ times in the production log, on every referral attempt while the referral system was off | imported |
| `escapeHtml` undefined at `index.js:429` | crash on any text message while maintenance mode was on | imported from `utils/format` |
| 9 × `handleAdminCallback(bot, { ...query, data: { ...query.data, data: 'x' } })` | spread a **string** into an object, so `data` became an object and every regex silently failed. Broke: delete category, set category, toggle ChatGPT mode, delete billing cycle, activate/delete reseller, toggle referral, toggle VIP-new-only, VIP broadcast | pass the string directly |
| `ADMIN_RESELLER_NEW_NAME` / `ADMIN_RESELLER_BALANCE` had no text handler | "Add reseller" and "Add balance" did nothing at all | handlers implemented, with API-key generation |
| `db.prepare(...)` + undefined `userId` in `sendDelivery` | VIP unlock on referral purchase never ran, swallowed by `try/catch` | use `dbRaw.prepare` and `order.user_id` |
| `NOT NULL constraint failed: orders.quantity` | crash (×3 in the log) when a user confirmed an order from a stale message after the session expired | session validated before INSERT, friendly "session expired" message |
| Undefined `recovered` in the delete-order log | threw after a successful delete, showing a false error | removed from the log line |
| `admin_product_<id>` callbacks | dead links — that callback does not exist | point to `admin_edit_p_<id>` |
| `answerCallbackQuery(messageId, ...)` | `message_id` passed where `callback_query_id` was expected | corrected |
| `message is not modified` / `message to edit not found` | harmless Telegram races flooding the logs | filtered out of `unhandledRejection` |

---

# Test results

| Suite | Result |
|---|---|
| Migration & features | 27/27 |
| Deposit security (attack simulations) | 14/14 |
| Fraud response | 14/14 |

The security suite replays the exact $1117.73 incident, plus front-running,
replay, amount guessing, back-dating, 400 concurrent reservations with zero
collisions, and reversal leaving a negative-balance debt trail.

## Manual checklist after deploying

- [ ] Send two messages to the support bot as a customer → welcome appears once, one `✓` line
- [ ] Open the chat as staff → the line becomes `✓✓`
- [ ] Restart the bot → the `✓✓` state is still correct
- [ ] Disable refunds on one product → it disappears from the customer's refund list
- [ ] Place more than 10 orders on a test account → all of them are listed, filters work
- [ ] Set a product to manual, buy it → task appears, customer is told it is queued
- [ ] Deliver the task → customer receives it, task moves to ✅
- [ ] Drop a product's stock to 0 → one alert, no repeats; restock → alert re-arms
- [ ] Wallet → USDT → asks for network, then amount, then gives a unique figure
- [ ] `logger is not defined` no longer appears in the log

---

# Part 10 — Later fixes

## Balance comparison bug

A customer with `$1.00` shown against a `$1.00` price was told
**"Insufficient balance"** and could not buy.

Cause: the check was `balance < price - 0.001`, while the interface rounds to
cents. A stored balance of `0.9989` displays as `$1.00` but fails that test.

Fix: `hasEnough()` compares whole cents, restoring the invariant the interface
promises — *if the two displayed figures are equal, the purchase goes through*.
Applied to all three call sites (wallet purchase, manual-delivery purchase,
preorder).

| Balance | Displayed | Price | Old | New |
|---|---|---|---|---|
| 0.9989 | $1.00 | $1.00 | refused | **passes** |
| 0.9951 | $1.00 | $1.00 | refused | **passes** |
| 0.9940 | $0.99 | $1.00 | refused | refused |
| 5.0000 | $5.00 | $5.01 | refused | refused |

## Erase a customer's order data

`🚨 Fraud → 🧹 Erase their order data`, with two levels:

* **🧽 Wipe delivered content** — clears `delivered_content` on their orders and
  manual tasks, so they can no longer read the keys from "My Orders". The rows
  stay, so sales and stock figures remain correct. This is the normal choice.
* **🗑 Delete everything** — removes the order rows entirely. Irreversible, and
  revenue/sales statistics change because those purchases disappear.

Other customers' data is never touched.

## Stock alerts inside the Support Bot

New section: `/alerts`, or the `🔔 Stock Alerts` button in the inbox.

Tabs (All / 🔴 Out of stock / 🟠 Running low), unread counters, pagination, and
mark-all-as-read. It reads the shared `admin_notifications` table, so an alert
raised by the main bot appears here with the same read state — marking it read
in one place marks it read everywhere. Manual-delivery and support-message
notifications are filtered out of this section.

## Reduced the unique-amount suffix

The reservation suffix was `0.000100–0.009999` (up to one cent). It is now
`0.000101–0.000999` — **at most a tenth of a cent**, averaging 0.055 of a cent.

| | Old | New |
|---|---|---|
| Range | 0.000100 – 0.009999 | 0.000101 – 0.000999 |
| Average cost | 0.505 of a cent | **0.055 of a cent** |
| Values per base amount | 9900 | 899 |

The smaller range does not weaken anything: correctness comes from the partial
UNIQUE index on open reservations, not from the size of the range. A collision
simply causes a redraw.

### The suffix is not a fee

Network fees never touch the USDT amount: BEP20 gas is paid in BNB and TRC20 in
TRX/Energy. The exact figure the customer sends is the exact figure Binance
receives, and the whole of it is credited to their wallet. This is visible in
the production log, where amounts like `35.12544802` and `18.12959494` arrived
with full six-decimal precision.

### Separate: the CryptoBot fee

`handlers/wallet.js` adds a fixed fee on top of CryptoBot top-ups, controlled by
the `cryptobot_fee_fixed` setting (default `0.01`). That one **is** a real charge
to the customer. Set it to `0` in `/admin → ⚙️ Settings` if you do not want it.

---

# Part 11 — Support console rework

## The problem

Inline keyboards live on one specific message. Once a few notifications arrive,
the message carrying the buttons has scrolled away and there is no route back to
the inbox — the console becomes unusable exactly when it is busiest.

## Persistent navigation bar

Staff now get a **ReplyKeyboard** pinned to the bottom of the chat:

```
[ 📥 Inbox    ] [ 💳 Payments ]
[ 📦 Delivery ] [ 🔔 Stock    ]
```

It never scrolls away. Every section is one tap from anywhere.

Taps arrive as ordinary text, so they are intercepted **before** the reply
forwarding logic — otherwise tapping `📥 Inbox` during a conversation would send
the literal words "📥 Inbox" to the customer. A tap also abandons any
half-finished input, which is what a person expects from a navigation button.

New commands: `/menu` (show the console), `/payments`. `/close` now returns to
the console instead of printing a bare line.

The send confirmation now names the recipient — `✅ Sent to @username` — so it is
never ambiguous who received a reply.

## 💳 Payments section

Two different problems, clearly separated:

| Tab | Meaning | Action needed |
|---|---|---|
| ⏳ **Awaiting Binance** | The transfer exists on-chain but Binance has not credited it (`status != 1`) | None — it clears on its own |
| 🛡 **Needs review** | The deposit matched no reservation | A human decision, taken in the main bot |

### Pending deposit tracking

New table `pending_deposits`. When `verifyDepositByTxId` reports `status != 1`,
the attempt is recorded with the amount, network, on-chain age and a retry
counter. `ON CONFLICT(txid) DO UPDATE` means repeated attempts bump the counter
instead of creating duplicates, and the row is deleted the moment the deposit
clears.

Support is notified **once per deposit**, not on every retry.

The customer-facing message was also improved: it now shows the amount and
network, and states that support can already see the deposit — so they stop
opening support tickets about it, which is what the tangled log showed happening.

## Stock alerts now name the product

The alert list showed eight identical rows reading "Product is running low"
with only a timestamp to tell them apart — useless when several products are
low at once.

Cause: the product name was written into the notification `body`, but the list
screens render the `title`, which was a fixed string.

Fixed in `services/stockAlerts.js`:

| Before | After |
|---|---|
| `Product is out of stock` | `Out of stock — Netflix Premium 1 Month` |
| `Product is running low` | `Low stock (3 left) — CapCut Pro Team 1 Month` |

The low-stock title also carries the remaining quantity, so you can triage
without opening anything.

### Existing alerts are rewritten too

A one-off backfill in `database/db.js` lifts the product name out of the body of
alerts already stored, so the 17 rows currently in the list become readable
rather than only new ones. Notifications of other types are untouched.

### Duplicate icon fixed

The unread marker was 🔴, the same glyph as the out-of-stock icon, so unread
rows read `🔴 🔴 Product is out of stock`. The marker is now 🆕.

## Stock alerts: live list, not a log

Previously the section accumulated every alert ever raised — 17 rows, mostly
"running low", including products that had long since been restocked. It had
become a history nobody could act on.

It is now a **live status list** answering one question: *what is out of stock
right now?*

### What changed

| | Before | After |
|---|---|---|
| Low-stock alerts | Always on | **Off by default** (`stock_low_alerts_enabled`) |
| After restocking | Alert stayed forever | **Alert is deleted** |
| Tabs | All / Out of stock / Running low | None — one list |
| Empty state | Blank | "✅ Everything is in stock" |

`evaluateStock` now deletes a product's alerts as soon as `stock_quantity > 0`,
and re-arms the latch so a future sell-out raises a fresh one. A product that
sells out → is restocked → sells out again produces exactly two alerts, and only
ever one row in the list at a time.

### Existing rows are cleaned up

A one-off migration removes:

* every `stock_low` alert (the feature is off now)
* `stock_out` alerts for products currently back in stock
* orphaned alerts whose product was deleted

and re-arms the latches on everything currently in stock.

### Bringing low-stock alerts back

`/admin → ⚙️ Settings → 🟠 Low-Stock Alerts On/Off`, or set
`stock_low_alerts_enabled` to `1`.

---

# Part 12 — Console counters, live stock, per-customer pricing

## Support bot: every section shows its own count

The inbox and the console now carry live numbers, so you can see where the work
is without opening anything:

```
🔴 Unread conversations: 12
💳 Payments to handle: 3
📦 Deliveries waiting: 2
🔄 Refund requests: 1
🔴 Out of stock: 8
```

When everything is clear it simply says **"Nothing needs attention."**

## Refund Requests in the support bot

New section (`/refunds`, or the `🔄 Refunds` bar button) listing pending
requests with customer, order, amount, method and reason.

Deliberately **read-only**: approving a refund moves real money, so the decision
stays in the main admin panel. This screen is for triage, with a shortcut to
message the customer.

## Out-of-stock list now reads the products table

Previously it listed stored notification rows, which had to be cleaned up to
stay accurate. It is now a live query:

```sql
SELECT ... FROM products
WHERE COALESCE(stock_quantity,0) <= 0 AND is_active = 1
```

The list therefore **cannot** drift. The moment stock is added the product stops
matching and disappears — no cleanup step, nothing to go wrong. Hidden products
are excluded.

## Per-customer pricing

`/admin → 👥 Users → [user] → 💲 Special Prices`

You **pick the product from a list** and then type only the price, e.g.
`3.50` or `3.50 wholesale deal`.

Typing a product id was the first design and it was a trap: the ordering screen
shows POSITION numbers (`#11` = eleventh in the list), not product ids, so it
was easy to price the wrong product. Tapping removes the ambiguity.

The product id is now also shown on the edit screen (`🆔 Product ID`) for the
times you do need it.

Implemented as a single choke point, `productForCustomer(userId, product)`,
which swaps `product.price` before anything reads it. Because every screen and
the checkout all read that one field, the quoted price and the charged price
cannot diverge. Applied at six sites: four in the buy flow, two in the product
displays.

A negotiated price also **switches off the bulk tiers** for that customer on
that product — the agreed figure is the agreed figure, whatever the quantity.
Other customers keep their tier pricing.

`UNIQUE(user_id, product_id)` means re-setting a price updates it instead of
stacking duplicates.

## Product ordering screen made readable

The old layout packed four buttons into each row (`#N | name | ▲ | ▼`), which
squeezed names into ~22 characters — `⭐Gemin`, `☀️Accou`, `✳️claude` — and with
25 products the screen was unusable.

Now: one product per row at full width, 10 per page, with paging and a header
showing totals. Tapping a product opens a small screen with move up/down, set
exact position, and edit. After a move the list returns to the page that product
is now on, instead of bouncing back to page 1.

## Two more pre-existing bugs fixed

| Bug | Impact |
|---|---|
| `ADMIN_REFUND_AMOUNT` was handled in `admin.js` but never listed in `index.js` | The admin's typed refund amount never reached the handler — refund-by-amount silently did nothing |
| `refreshSortView()` was called with an undefined `productId` in `admin_resetorder` | Introduced during this work and caught before shipping |

---

# Part 13 — Customer API (v2)

Any customer can mint an API key from the bot menu — no application step. The
key identifies one telegram user, and every purchase is charged to that user's
ordinary wallet at that user's ordinary price.

`🔌 API Access` in the main menu shows the key, the wallet balance, request
count, ready-to-paste curl examples, and a button to regenerate the key.

## Endpoints — `/api/v2`

| Method | Path | Purpose |
|---|---|---|
| GET | `/products` | Products, priced for the caller |
| GET | `/product/:id` | One product |
| GET | `/balance` | Wallet balance |
| POST | `/purchase` | Buy, paid from the wallet |
| GET | `/orders` | Order history |
| GET | `/order/:id` | One order, with delivered content |
| GET | `/docs` | Documentation |

Auth: `X-API-Key: sk_...`. Rate limit 60/min, plus a per-key in-flight lock so
two concurrent purchases cannot both pass their own balance check.

## Why it reuses the bot's purchase function

`POST /purchase` calls `deliverOrderAndChargeWallet` — the exact function the
bot uses. One code path, one transaction, one source of truth for balance and
stock. Prices come from `resolveCustomerPricing`, so special prices and
allowances apply through the API automatically.

Manual-delivery products are supported: payment is taken, the order moves to
`awaiting_delivery`, and a task is opened for the admin.

## A serious bug this uncovered in `/api/v1`

The bot delivers from `stock`, falling back from `product_items`. The v1
reseller API read **only** `product_items`. Since the admin's "add stock" writes
to `stock`, that meant:

* `GET /products` reported `stock: 0` on a full shelf
* `POST /order` answered "Out of stock" for every request
* and if both tables ever held rows, the same unit could be sold twice while
  `products.stock_quantity` was decremented for each

v1 now reads and writes the same pool as the bot, in the same order.

Separately, reseller accounts could not be created at all until this session:
`ADMIN_RESELLER_NEW_NAME` had no text handler, so no API key could ever be
issued and v1 was unusable regardless.

## Tests

16/16, run against the real stock layout (rows in `stock`, `product_items`
empty): auth, banned accounts, insufficient balance, insufficient stock, and a
no-double-sell check confirming three stock rows produce exactly three sales.

## Compatibility aliases

Other shops in this market name the same two endpoints differently, so both
spellings are accepted:

| Alias | Same as |
|---|---|
| `GET /me` | `GET /balance` |
| `POST /order` | `POST /purchase` |

A reseller who already wrote code against another supplier can point it here by
changing only the base URL and the key.

## Failed purchases no longer leave pending orders

The order row is created before the atomic charge runs. If the charge fails
(insufficient balance, out of stock), the row is now closed as `cancelled`
instead of sitting in the customer's history as `pending` forever.

---

# Part 14 — Customer Wallets (treasury)

`/admin → 🏦 Customer Wallets`

Shows what the shop is currently holding on customers' behalf:

* total balance across all wallets, and how many customers hold one
* average and largest wallet
* wallets in debt, with the total — these come from reversed deposits that had
  already been spent
* reseller balances (the separate `/api/v1` accounts), when any exist
* lifetime wallet flow: credited in vs spent out, broken down by transaction type
* `🏆 Largest wallets` — top 15 with each one's share of the total

The screen states plainly that this is a **liability, not profit**: the money has
been received, but customers can still spend it or ask for it back.

## Half-a-cent threshold

"Customers with a balance" counts wallets above `0.004`. A balance of `0.002`
displays as `$0.00`, so listing it as funded would contradict what the interface
shows — the same cent-rounding rule used for the purchase check.

## API documentation page

`/api/v2/docs` now serves a real page instead of raw JSON. The machine-readable
version moved to `/api/v2/docs.json`.

It covers: a three-step start (get key → top up → call), every endpoint with a
copy-ready curl request beside its response, the request fields for `/purchase`
marked required / optional / conditional, and a status-code ledger written as
instructions rather than definitions — for a reseller a `402` is not an error,
it means "go top up", so that is what it says.

### `trust proxy`

Railway terminates TLS at its edge and forwards over plain HTTP, so
`req.protocol` reported `http` and every URL printed in the docs was wrong —
resellers would have copied links that do not work. `app.set('trust proxy', true)`
fixes it.

---

# Part 15 — Persistent menu bar for customers

The main bot used inline keyboards only, so the menu scrolled out of reach as
soon as a few messages arrived — the same problem the support console had.

Customers now get a **ReplyKeyboard** pinned to the bottom of the chat:

```
[ 🛍 Products  ] [ 💰 Wallet  ]
[ 📦 My Orders ] [ 💬 Support ]
```

Four buttons, not more: on a phone a third row pushes the conversation off
screen, and everything else is reachable from these four.

Labels are localized, and the bar is re-sent when the language changes so it
never sits in the previous language.

## The risk this had to avoid

Bar taps arrive as **ordinary text messages**. Handled in the wrong order, a tap
on `🛍 Products` during the quantity step would be parsed as a quantity, and
during a top-up it would be parsed as a TxID.

So the interceptor is registered as the **first** `bot.on('message')` handler,
before every input handler, and returns immediately once it matches. A tap also
clears any half-finished input, which is what a person expects from a navigation
button.

Matching is done against **all four languages**, not just the customer's current
one: after switching language the old bar stays on screen until Telegram
replaces it, and those taps must still work.

Matching is exact-equality per label, so ordinary input is never swallowed —
`Products`, `🛍`, `5`, an email, a TxID and `I have a question about 🛍 Products`
all pass through untouched. Verified: 14/14.

## Signatures checked, not assumed

The first version of this called `showProducts(bot, chatId, userId, null)` and
`showSupport(bot, chatId, userId, null)`. Neither takes a `userId` — the calls
were written from memory and would have shown the wrong page. The real
signatures were read from the source and each call is now verified against them
automatically.

---

# Part 16 — Configurable minimum deposit, ChatGPT Business stock

## Minimum deposit was hard-coded

`handlers/wallet.js` opened with `const MIN_DEPOSIT = 1` and used it in seven
places. The `MIN_DEPOSIT` environment variable and the `min_deposit` setting
were both seeded and both **ignored** — changing either did nothing anywhere.

It is now read from settings on every call, so `/admin → ⚙️ Settings →
💵 Minimum Deposit` takes effect immediately with no redeploy. Values below a
cent are supported and displayed without trailing zeros (`0.05`, not
`0.050000`). A blank, non-numeric, zero or negative value falls back to `1`
rather than letting a typo disable the floor entirely.

## ChatGPT Business out-of-stock switch

`/admin → 🤖 ChatGPT Business → 🔴 Mark out of stock`

The panel header shows the current state, and the message customers see is
editable from the same screen.

Stored as a flag rather than a stock count: a seat is not taken off a shelf —
either you can serve another customer or you cannot.

### Checked in two places

* when the offer is drawn, so nobody is quoted a price that cannot be honoured
* again when Order is tapped, because a customer can sit on an old message for
  hours and tap it after seats have sold out

The out-of-stock screen offers `🔄 Check again` so a customer can retry without
restarting.

---

# Part 17 — Recall a reply, copy a customer message

The conversation is rendered as one transcript message, so individual lines
cannot carry buttons. Both actions therefore work the same way: pick from a
short list of recent messages, then act on the one you picked.

Two new buttons in the chat view: `📋 Copy text` and `🗑 Recall reply`.

## 🗑 Recall a reply

Removes one of your own messages from the customer's chat as well as yours.

This needed a schema change: `support_messages.tg_msg_id` now stores the id
Telegram assigns in the **customer's** chat. It was never captured before, and
without it a message cannot be deleted at all.

The row is **marked** deleted, not removed — the transcript keeps showing it,
struck through and tagged `(recalled)`. Support history should not quietly
rewrite itself, and you need to remember what you withdrew.

### The 48-hour limit

Telegram will not let a bot delete its own messages after 48 hours. When that
happens the screen says so plainly and warns that the customer can still see the
message, rather than reporting a success that did not happen.

Replies sent before this update have no `tg_msg_id` and are excluded from the
list — they genuinely cannot be recalled.

## 📋 Copy a customer message

Pick a message and it comes back on its own as a code block, so one tap copies
exactly that text and nothing else.

Wallet addresses, emails and order numbers are painful to select out of a long
transcript on a phone; this is what the feature is for. Media messages are left
out of the list since there is nothing to copy.

Tested: 13/13 — list filtering by direction and customer, a 34-character TRC20
address copied without truncation, recall marking without deleting, no double
recall, and exclusion of replies with no stored message id.

---

# Part 18 — Command menu (desktop fix)

## The problem

Telegram Desktop does not display a ReplyKeyboard the way phones do. It hides it
behind a small icon in the input field, and frequently shows nothing at all — so
the persistent bar added in Part 15 was invisible on a computer.

## The fix

Register the bot's commands with Telegram, which puts a **☰ Menu** button beside
the input. That behaves identically on desktop and phone, so it is the
dependable route in on a computer.

Commands were already implemented in both bots (`/inbox`, `/payments`, …) but
had never been registered, so Telegram did not know they existed and the menu
button never appeared.

### Scoping

Registration is scoped so the wrong people never see the wrong commands:

| Audience | Sees |
|---|---|
| Support bot — customers | `/start` only |
| Support bot — staff | menu, inbox, payments, manual, refunds, alerts, close |
| Main bot — customers | start, products, wallet, orders, support |
| Main bot — admins | the above plus `/admin` |

Staff and admin lists use `BotCommandScopeChat`, registered per chat id.

### First-time staff

Scoped registration fails for anyone who has never opened the bot — Telegram has
no chat to attach the scope to. `ensureStaffCommands()` re-registers on the first
interaction, so a new staff member does not need a restart.

### New shortcuts in the main bot

`/products`, `/wallet`, `/orders`, `/support` open the same screens as the bar.

Verified: none of them is captured by the nav-bar interceptor, and the state
handler already skips any message starting with `/` — so typing a command while
entering a quantity or a TxID does not get parsed as input. 8/8.

---

# Part 19 — ChatGPT Business order cards: red until activated, green after

## Why they looked alike

Two problems compounded:

1. The pending button read `✅ Notify Customer` and the finished one
   `✅ Customer Notified` — **both opened with a green tick**.
2. Pressing the button called `editMessageReplyMarkup`, which changes only the
   button. The message body never changed, so a finished order still said
   "Press the button below to notify the customer".

Scrolling back through a day's orders, nothing distinguished done from pending.

## Now

The whole card is banded — a solid bar top and bottom, so the state reads
correctly even when the card is half scrolled off screen:

```
🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥        🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩
🔴 NOT ACTIVATED YET           🟢 ACTIVATED — customer notified
   — action needed
   …order details…                …order details…
⬇️ Activate the seat, then      ✅ Activated 19/08 17:32.
   press the button below.         The customer has been told.
🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥🟥        🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩🟩
```

The pending button is now `🔔 Activate & Notify Customer` — no tick, since the
tick was half the confusion. After pressing: `✅ Done — customer notified`.

## Rebuilt from the database, not from the message

The first attempt reconstructed the green card by parsing the old message text.
That is fragile: `q.message.text` arrives with HTML already decoded, so
re-escaping it by hand would mangle any address containing `&` or `<`.

The card is now rebuilt from `chatgpt_subscriptions` and `orders` using the
order id already carried in the callback data. If that ever fails, the button
still flips, so a completed order is never left looking untouched.

Both order paths (direct payment and CryptoBot) now share one `orderCard()`
builder instead of two copies of the same message.

---

# Part 20 — Wrong-asset deposits (Binance Pay)

## The attack

Reported by another shop owner: a customer sent ~160,000,000 BTTC — worth a few
cents — where the bot expected 160 USDT. The bot read `amount: 160` (or a large
number) and credited it as dollars, because nothing checked *which asset* had
arrived. Binance Pay carries any listed token, so the amount alone says nothing
about value.

## Where this bot stood

| Path | Before |
|---|---|
| USDT deposit by TxID | **Safe** — the Binance history is queried with `coin: 'USDT'`, and `services/binance.js` re-checks `match.coin` explicitly |
| Binance Pay → wallet top-up | Safe — `handlers/wallet.js` checked `result.currency` |
| Binance Pay → direct purchase | Safe — `handlers/buy.js` checked `result.currency` |
| Binance Pay → **ChatGPT Business** | **VULNERABLE** — only the amount was compared |

`verifyBinancePayOrder` returned `currency` but never checked it, leaving each
caller to remember. Two of the three did; the ChatGPT bot did not.

A $14.94 subscription could therefore be bought with 14.94 BTTC — about
$0.0000067.

## The fix

Two layers:

1. **`services/binance.js`** now rejects any Binance Pay transfer whose
   `currency` is not USDT, before returning `found: true`. Every caller is
   covered whether it remembers to check or not.
2. **`chatgpt-bot.js`** checks the currency itself as well, before the amount
   comparison.

Centralising it in the verifier is the important half: a guard each caller has
to remember will eventually be forgotten again — that is exactly how this one
got through.

---

# Part 21 — Billing cycles use both ends; AI Assistant "Not found"

## Cycles
`calculateBestCycle` read only `end_day`. A cycle of 26 → 24 was treated as
"ends on the 24th", so a buyer on the 25th (a day in no cycle) was sold a
period starting that same day, and every price was split over a fixed 30.

Now, in `services/cgbCycles.js`:
* Inside a cycle: the period runs from today to the cycle end.
* Between two cycles: it starts on the next start day, at full price. The order
  card is blue (paid early) until that day.
* Price = monthly × days ÷ **the cycle's real length** (29 days for 26 Sep → 24 Oct),
  so a whole cycle always costs exactly the monthly price.
* "Add a full month" adds the next whole cycle, not a flat 30 days.
* Day 31 clamps to the month's last day instead of rolling into the next month.

## AI Assistant
* The admin button now tests `<domain>/agent/ping` before showing the link, and
  says why it fails (wrong `/apibase`, domain on another service, old deploy).
* `/apibase` and the assistant keep only the domain — a saved path such as
  `/api/v2` produced `/api/v2/agent/`, a Not found page.
* `/agent` without a trailing slash redirects to `/agent/`; otherwise the page's
  relative calls went to `/chat` at the site root.
* `AGENT_MODEL` naming the other provider's model is ignored with a warning,
  and a provider 404 is reported as "model not found" rather than a bare 404.
* The page's token was substituted with `String.replace`, which swaps only the
  first occurrence. The chat's copy stayed as the literal `__TOKEN__`, so the
  page opened but every message returned "Invalid or missing token". Fixed with
  split/join; the page also prefers the token from its own address bar.

# Part 22 — Smarter assistant, speaks the owner's language

* Replies to the owner in the language and dialect of their last message
  (Tunisian Derja stays Derja). Drafts for customers are English unless the
  owner names another language.
* Strongest model by default: `gpt-6-astra` → `gpt-6-sol` → `gpt-5.6-sol` →
  `gpt-5.5` → `gpt-4o` (Anthropic: `claude-opus-5-5` → `claude-sonnet-5` →
  `claude-sonnet-4-6`). A model the account cannot use is skipped once and the
  working one is remembered. Reasoning effort `high`; refused parameters are
  dropped and retried.
* New tool `support_digest`: every conversation of the last N hours in one call,
  with waiting/unread flags — used for "read the chats and summarise".
* Up to 16 tool rounds per answer (was 8); threads readable up to 300 messages.

# Part 23 — OpenAI Responses API

GPT-6 refused tools + `reasoning_effort` on `/v1/chat/completions` ("Function
tools with reasoning_effort are not supported … use /v1/responses"). Reasoning
models now go through `/v1/responses` with `reasoning.effort = high`, chained
with `previous_response_id` so reasoning carries across tool calls and messages.
The gpt-4 family stays on chat/completions.

# Part 24 — Sahbi: fast, remembers, streams

* **Two tiers, chosen per message** (`services/agentChat.js → pickTier`): fast
  (`gpt-6-sol`, reasoning low) for look-ups and chat; deep (`gpt-6-astra`,
  reasoning high) for summaries, analysis, advice, long messages. The app's mode
  button forces ⚡ / 🧠 or leaves ✨ Auto. Each tier falls back on its own chain.
* **Streaming** (`POST /agent/chat/stream`, server-sent events): words appear as
  they are written, each tool step is shown live, ■ stops the answer and cancels
  the upstream request. `/agent/chat` (non-streaming) still works.
* **Memory** (`services/agentMemory.js`, tables `agent_memory`, `agent_chat`,
  `agent_state`): the assistant's notebook, the only thing it may write. Tools
  `remember`, `update_memory`, `forget`, `recall_memory`, `search_past_chats`.
  Notes are injected into every prompt; the chat log survives restarts and is
  reloaded when the app opens; the OpenAI chain id is persisted and rebuilt from
  the local log if it expires.
* **Awareness**: a live snapshot (waiting chats, manual deliveries, seats to
  activate, refunds, deposit reviews, out-of-stock, today's sales) goes into every
  prompt and into the brief bar at the top of the app — no AI call needed.
* New tool `recent_activity`: one merged timeline across all three bots.
* **Persona**: "Sahbi" — loyal, direct, answers in the owner's own dialect.
* **App**: input grows with the text (Enter = new line on phones), voice input
  (Tunisian / Arabic / French / English), memory panel, copy buttons, markdown,
  new-chat divider, Arabic UI. Page moved to `services/agentPage.html`.

# Part 25 — Sahbi speaks first

`services/agentWatch.js`, started from `index.js`, runs every 5 minutes:

* **Rules (no AI, free)**: customer waiting for a reply longer than N minutes
  (default 30); manual delivery stuck > 30 min; ChatGPT seat due today; deposit
  review pending > 1 h; a product selling fast enough to run out within 24 h (or
  already out while selling); a customer with ≥3 refund requests in 30 days (or
  refunds ≥ half their purchases); the shop silent for 3 h at an hour that
  normally sells; good customers (≥5 orders) who stopped buying 14–60 days ago,
  with a win-back idea. All findings of one tick go out as ONE Telegram message
  from the store bot to the admins, each only once, held back in quiet hours.
* **Briefs (AI, deep tier)**: morning (09:00) and evening (22:30) on the shop's
  clock — what happened, what needs action, 💡 ideas grounded in the data. They
  continue the same conversation, so the owner can reply "tell me more about 2".
* Everything is also shown in the app (amber alert cards, ☀️/🌙 badges), polled
  every 45 s and when the app returns to the foreground.
* Sahbi's prompt now includes the alerts it sent, and it ends answers with one
  data-grounded 💡 idea when it has a good one.
* App → 🧠 → 🔔: toggles, wait threshold, quiet hours, brief times,
  "☀️ brief now" and "🔍 check now". Routes: `/agent/settings`,
  `/agent/brief/now`, `/agent/watch/now`.

# Part 26 — Token diet

* Models: fast = `gpt-6-luna` ($0.10/$0.50 per 1M), deep = `gpt-6-sol` ($2/$10).
  Astra ($10/$50) is no longer in any chain — pin `AGENT_MODEL_DEEP` to use it.
  Reasoning effort: fast low, deep medium.
* Deep tier only for explicit summary/analysis words (or long messages, or the
  🧠 button); can be disabled entirely in the app.
* Conversation chain closed once its input passes 25k tokens (a chained
  response re-bills the whole history every call).
* Smaller everything: 8 tool rounds, tool results capped at 12k chars,
  support_digest 25 threads × 8 messages × 220 chars, recap 6 turns, memory
  2–3.5k chars, 2 recent alerts, output caps 2.5k / 6k.
* Snapshot answers greetings and "what's waiting" with no tool call.
* Usage and cost tracked per day (`agent_state usage_YYYY-MM-DD`); daily cap
  (default $0.50) stops every AI call once reached — rule alerts keep running.
  Shown in the app header and in 🧠 → 🔔.
* AI briefs are opt-in, one per day, on the cheap tier, with a fixed tool budget.

# Part 27 — Seat start date shifted a day on non-UTC servers

`chatgpt-bot.js formatDate` used `toISOString()`, which converts to UTC first.
Cycle dates are wall-clock midnights, so with `TZ` set to anything east of UTC
(e.g. `Africa/Tunis`) a seat bought between cycles was stored as starting
today (25) instead of the cycle start (26), and its card was red instead of
blue. It now formats the calendar day as written. Verified under UTC,
Africa/Tunis, Europe/Paris and America/New_York.

# Part 28 — The running cycle wins

`calculateBestCycle` picked the cycle with the most days even if it had not
started yet, so a buyer on the 25th was pushed to the cycle opening on the 26th.
Now a cycle running today always wins (most days left among the running ones);
a cycle that has not started is used only when none is running. The cycles
panel marks cycles that have not started yet.

# Part 29 — Each cycle's renewal time

* `billing_cycles.start_time` ("HH:MM", shop clock; NULL = 00:00).
* Cycles panel: under each cycle, "⏱ Day N: press at billing time". Pressed on
  the cycle's start day, it records the current time; on any other day it
  refuses. Afterwards the button reads "⏱ Day N renews at 14:32 · reset".
* Before the recorded time on the start day, the new cycle has not opened:
  buyers join the running cycle. From that minute on, they join the new one.
* `localNow` now removes the server's own timezone before applying the shop
  offset, so shop time is right whatever `TZ` the server has (it was shifted
  twice on non-UTC servers).

# Part 30 — API items, renewals round, Sahbi v2

* **API items without `<code>`**: `api-public.js` / `api-reseller.js` return items
  through `plainItem()`, which strips the Telegram formatting tags. Stored
  content and the bot's own messages are unchanged.
* **Renewal reminders** (`chatgpt-bot.js sendRenewalReminders`): daily, at
  `cgb_reminder_hour` (default 10:00 shop time), from `cgb_reminder_start_before`
  days before the seat ends (default 1 → the 23rd for a seat ending the 24th)
  until the day the next cycle opens (the 26th). Buttons: ✅ Yes, renew → payment
  screen; ❌ No → never reminded again. Stops once a renewal is paid. A customer
  who said yes but did not pay gets "💳 Complete payment". Columns
  `reminder_last_date`, `reminder_count`.
* **/renewals dashboard**: round overview (paid & revenue, yes-unpaid, no
  answer, declined, activate now / later) with a list per section, pagination,
  and a button per seat that opens its order card with the Activate button.
  "Renewal paid" admin message restyled with where to activate and a link.
* **Sahbi**: app-only (the watcher no longer writes in Telegram; phone
  notifications from the app instead). New read-only tools: `txid_check` (live
  Binance deposit + Binance Pay lookup combined with the shop's own trace, with a
  verdict), `recent_deposits`, `cgb_cycle_now`, `cgb_renewals`, `cgb_find_seat`,
  `order_lookup`. Tools may be async and run in parallel. Voice notes are
  transcribed server-side (`/agent/transcribe`, gpt-4o-mini-transcribe →
  whisper-1, Derja hint); replies can be read aloud (🔊, phone voice or
  `/agent/tts`). Audio cost counts toward the daily budget. Conversational tone.

# Part 31 — Sahbi adds stock, sees images, talks live

* **Stock**: `find_product` (fuzzy names) and `propose_stock`. The owner pastes
  accounts in any format; the model either passes them joined with AYMEN or has
  the server split the owner's own message (`split_by`: auto / lines /
  blank_lines / aymen / sep:…, header lines dropped, multi-line accounts kept
  whole). Duplicates in the batch or already in stock are skipped. Nothing is
  written until the owner taps ➕ on the preview card → `POST /agent/stock/approve`
  → `services/stockUpload.js`, which does exactly what the panel's DONE does
  (insert, counter, low-stock check, back-in-stock pings, channel post). Drafts
  are single-use and expire after an hour. `app.set('storeBot')` added.
* **Images**: the owner can attach photos (resized on the phone), paste
  screenshots, or attach .txt/.csv lists. `view_customer_media` downloads a
  customer's photos (shown to the model) and voice notes (transcribed).
* **📞 Direct talk**: hands-free loop in the app — listens, detects silence,
  transcribes, answers, speaks, listens again.
* **Learning & personality**: lessons from corrections saved as "lesson" notes
  and applied; a running "business" profile; own opinions. Fast tier thinks at
  medium effort for actions and images.
* **Support bot**: opening a chat's media puts 🔙 Back to chat / 📥 Inbox under the
  LAST attachment instead of above all of them.

# Part 32 — Stock formats Sahbi learns

* The splitter drops list numbering ("1. ", "2) ", "- ", "•") at the start of an
  account, and Arabic notes typed after the last account on the same line.
* `propose_stock` returns `first_account_full`, `odd_accounts` (accounts whose
  shape — @, :, |, links, lines — differs from the rest) and `remembered_format`
  (the owner's saved format notes for that product). Previews show 320 chars.
* Sahbi asks "where does one account start and end?" when the format is new or
  something looks odd, then saves the answer as a "format" note per product and
  stops asking.

# Part 33 — Premium icons no longer switched off by one bad message

`utils/emojiLayer.js` treated any "can't parse entities" / "entity" /
"media_empty" error as a custom-emoji failure. When the emoji in that message
all verified as valid, it concluded Premium was off and paused EVERY icon in
the bot for 15 minutes — after a single failure, often caused by a stray "<"
in an unrelated message.

* Errors are split: strong (DOCUMENT_INVALID, custom emoji, emoji/stickerset
  invalid) vs weak (parse/entity/media). A weak error only retries that one
  message without custom emoji; no quarantine, no pause.
* The 15-minute pause now needs 3 refusals of valid emoji within 2 minutes.
* The last events (what happened, which bot/method, Telegram's message) are
  kept and shown in /emojistatus; Sahbi's `emoji_status` tool reads them and
  the watcher alerts in the app when icons are paused or switched off.

# Part 34 — Yamen

* The assistant is now **Yamen · يمان**, with its own icon (app, header, call
  screen, home-screen install).
* `propose_stock_count` — add N to a manual-fill product's counter (e.g. Claude
  Team Standard); `propose_post` — a post for the channel, group or both, with
  the product photo and a Buy button when a product is attached; the HTML is
  limited to Telegram's tags. Both are confirmed by the owner's tap through
  `POST /agent/action/approve` (single use, 1 h expiry); manual stock runs the
  low-stock check and back-in-stock pings like the panel.
* Voice: in 📞 calls the reply is spoken sentence by sentence while it is still
  being written; talking over Yamen interrupts it; the listener calibrates to
  the room's noise and ends a turn after 0.85 s of silence; speech is a little
  faster (server TTS speed 1.1, playback 1.08, phone voices 1.12).
* Premium icons: the emoji event log is stored in settings (`emoji_incidents`)
  so it survives a redeploy, and every boot verifies all product icons with
  Telegram (no message sent) and records the result — /emojistatus shows it.

# Part 35 — Yamen's studio

`services/agentStudio.js` — everything prepared, applied only on the owner's tap:

* `propose_product` — a new product (title, price, description, warranty,
  after-purchase instruction, category, auto/manual/unlimited delivery, email
  requirement, premium icon, the owner's attached photo, unit cost). The photo
  is uploaded once to the owner's chat to get a reusable Telegram file id.
* `propose_product_update` — price, title, description, warranty,
  instruction, hide/show, category, delivery, cost/wholesale, icon, photo;
  shown as before → after.
* `propose_post` (replaces the V100 one) — channel / group / both / users (every
  customer's DM, sent in the background with a report) / all; product photo or
  the owner's own photo; up to 6 buttons ("Label|url", "Label|product:ID",
  "Label|bot", short ones paired); `schedule_at` on the shop clock. Long text
  with a photo goes as photo + message (caption limit).
* `scheduled_posts` — list or cancel; the watcher publishes due posts every
  minute. `list_categories`.
* Persona: a post-design playbook (launch, restock, flash sale, price drop,
  bundle, news) and a product-writing guide.

# Part 36 — Manual delivery fast lane

Personal invites (Canva Teams) stay manual — one invite per customer email,
nothing automated touching the team — but everything around that step is gone.
`services/mdFast.js` + support bot:

* Task cards: 📋 Email (Telegram copy button — one tap copies the address) and
  🔗 Canva (the team people page). `/mdlink <productId> <url> [must-contain]`
  sets the page and expected content for any other manual product.
* Reply to a task card with the content → delivered. No Deliver button needed.
* Content check: a pasted email, or anything without `canva.com/brand/join`
  for Canva products, is held with "📤 Send anyway" instead of being sent.
* Assembly line: after each delivery the next pending task (same product
  first) comes up armed — paste, next, paste. ⏭ Skip / ⏹ Stop.
* Customers receive a single link as an "✅ Accept invitation" button, with a
  line telling them which email to sign in with.
* Replying to an already delivered task sends nothing.

# Part 37 — Canva Teams auto-invite (opt-in)

`services/canvaBot.js` + `services/canvaLoginPage.js`. Off unless
`CANVA_AUTOMATION=1`; then a paid Canva order invites the customer's email and
delivers the personal join link automatically, with no human step.

* Headless Chromium (`playwright-core` + `@sparticuz/chromium`), logged in ONCE
  via a remote-login page (`/agent/canva/login`, gated by AGENT_TOKEN): it
  streams the login screen and relays taps/typing; only the Canva session is
  saved to disk (`CANVA_DATA_DIR`), never a password.
* Invites are serialised behind a lock with a ≥20 s gap and small random delays
  — never two at once, never machine-gunned.
* Fails safe: not logged in, page changed, or no link → the order drops to the
  manual fast lane (Part 36); an order is never marked delivered without a real
  link. Session expiry clears the saved session and tells the owner to re-login.
* `/canva` in the store bot: status, remote-login link, check, forget session.
  Yamen tool `canva_status`. `nixpacks.toml` adds Chromium's system libraries.

Note: automating Canva Teams carries account risk (it is against Canva's terms
and their anti-automation checks can suspend the team). The safeguards above
reduce it; they do not remove it. The manual fast lane remains the safe default.

# Part 38 — Canva login "nothing happened": diagnosis + reliable Chromium

The remote-login page hung on "opening Canva…" because Chromium could not start
on the server and the failure was swallowed.

* The page now shows the real error and a retry button instead of hanging.
* Chromium resolution is robust: a system Chromium (installed by nixpacks) or
  `CHROMIUM_PATH` is preferred over the Lambda-tuned bundled binary; a missing
  system library is named in the error.
* `nixpacks.toml` now installs `chromium` and sets `CHROMIUM_PATH`.
* `/canva` gained a "🧪 Test browser" button (`selfTest`) that opens the browser,
  loads a test page and reports exactly what works or what is missing — run it
  before logging in.

# Part 39 — "Unexpected token '<'": it was a stale deploy

That error means `/agent/canva/start` returned HTML, not JSON — i.e. the route
did not exist on the running server, so it fell through to a 404 page. The code
was correct; Railway was still serving an older build.

* `/agent/ping` now reports the running `version` and whether `canva` is on, so
  the deployed build can be confirmed at a glance.
* `/version` in the store bot shows a Canva-automation line (and "module missing
  (old build)" when the deploy is stale).
* The login page now detects an HTML (non-JSON) reply and says plainly that the
  deploy is stale and needs a full Redeploy, instead of a raw parse error.

# Part 40 — Yamen: sees images, adds balance, can auto-reply

* **Images now read.** A message with a photo is routed to a vision model
  (gpt-6-sol / claude-sonnet-5) for that turn instead of the text-only luna, so
  Yamen actually reads screenshots, payment proofs and error screens and acts on
  them. (The plumbing existed; the cheap model could not see.)
* **Add balance** — `propose_credit`: a refund/compensation/bonus up to
  `AGENT_CREDIT_CAP` ($20 default), owner taps to confirm; above the cap it
  refuses and points to /admin. Credits the wallet, logs a transaction, and DMs
  the customer.
* **Optional auto-reply** — `send_reply_now`, gated by an app toggle (default
  OFF) AND a safe-category whitelist (how-to, delivery time, instructions,
  stock, greeting). Anything about money, refunds, complaints, promises, prices
  or account problems is always turned into a draft the owner approves — even
  with the toggle on. Setting: app → 🧠 → 🔔 → "💬 نسمحلو يجاوب الحرفاء وحدو".

# Part 41 — Yamen searches the web

* On the OpenAI Responses path, Yamen now has OpenAI's native `web_search`
  (no key, no scraping). It decides when to use it — activation steps, a current
  error, a fact not in the shop data — and a "🌐 يبحث في الويب" status shows while
  it searches. Off with `WEB_SEARCH=0`.
* For the Anthropic / gpt-4 paths, key-free fallback tools `web_search`
  (DuckDuckGo instant-answer API → Lite HTML) and `web_read` (readable page
  text). They degrade gracefully to "search unavailable — answer from what you
  know" if the host blocks them; the native path is unaffected. The fallback
  pair is dropped on the Responses path to avoid a name clash.
* Persona: search only when the answer is not in shop data or Yamen's knowledge;
  read the best result and answer in its own words.

# Part 42 — Canva login: the real bug, a persistent session, CANVA_SESSION (v109)

* **The real cause of the dead login page.** Part 39 blamed a stale deploy; that
  was wrong. The page lives at `/agent/canva/login` and called `canva/start`
  with a *relative* path, which the browser resolves to
  `/agent/canva/canva/start` — a route that never existed → Express's HTML 404
  → "not JSON". Every call is now built from the page's own folder. The page
  script sits inside a template literal (which eats backslashes), so the URL
  building uses plain string ops, not regex. Tested by serving the page and
  hitting every route from both `/login` and `/login/`.
* **Session survives deploys.** It used to live in `/tmp/canva-session`, which
  Railway wipes on each deploy (silent logout). It now sits next to the
  database on the volume (`dirname(DB_PATH)/canva-session`). An explicit
  `CANVA_DATA_DIR` still wins, except the old `/tmp` default.
* **`CANVA_SESSION` variable.** Log in on your own computer, export canva.com
  cookies (Cookie-Editor → Export → JSON), paste into Railway. Raw JSON or
  base64; Cookie-Editor arrays and Playwright storageState both accepted;
  non-Canva cookies dropped. It seeds the session file only when its content
  changes, so a redeploy keeps the fresher on-disk session the bot maintains.
* `/canva` now shows where the session is stored (volume ✅ / /tmp ⚠️) and the
  CANVA_SESSION state (cookie count or the parse error).
* The error on the login page now shows the HTTP code and URL instead of
  guessing a cause.

# Part 43 — Chromium on Railway: a Dockerfile (v110)

* **Why "libnss3.so missing".** Newer Railway projects build with Railpack,
  which ignores `nixpacks.toml` — so neither Chromium nor its libraries were
  ever installed, and the bundled fallback Chromium could not start.
* **`Dockerfile` added.** Railway always uses a Dockerfile when one exists, so
  the build no longer depends on Railway's default builder. Base
  `node:20-bookworm-slim` + Debian's `chromium` package (pulls every library
  it needs) + fonts; `CHROMIUM_PATH=/usr/bin/chromium`. `WORKDIR /app` kept so
  the volume at `/app/data` stays where it was. `.dockerignore` keeps local
  `data/`, logs and `.env` out of the image. `nixpacks.toml` kept as fallback.
* **`package-lock.json` synced.** It lacked `playwright-core` and
  `@sparticuz/chromium`, so `npm ci` refused to install. Existing dependency
  versions unchanged.
* **Real volume check.** v109 said "volume ✅" for any path outside /tmp. The
  session folder is now checked against `/proc/mounts`: only a real separate
  mount (not the container root / overlay / tmpfs) counts. `/canva` shows the
  mount point.
* Error messages now point at the builder setting instead of nixpacks.
* Tested: the bot's own launch code starts a real Chromium and streams a
  screenshot; volume detection against real mounts; the whole v109 suite.
  The Docker build itself cannot run in the sandbox (no Docker).

# Part 44 — "Check login did nothing" + silent invite failures (v111)

* **Check login looked dead.** The main callback router (`handleCallbackQuery`)
  also receives every button tap and answers it at once with an empty reply.
  Telegram accepts one answer per tap, so the Canva result popup, sent 10–30 s
  later, was rejected and swallowed. All `canva_*` buttons now reply with
  MESSAGES: "⏳ Checking…", then the result.
* **Check login sends a screenshot** of what the server sees (plus the URL on
  failure), so a login wall, a security check or a changed page can be told
  apart at a glance.
* **Failed auto-invites were silent.** The failure path called
  `require('./canvaAlert')`, a file that never existed; the throw was
  swallowed, so the owner never learned why an order went manual. It now sends
  a Telegram alert "⚠️ Canva auto-invite failed → manual" with the reason (and
  a hint to paste a fresh CANVA_SESSION when the session expired); the manual
  task still opens as before.
* Tested with a mock Telegram enforcing the one-answer-per-tap rule, the real
  failure path of `openManualDelivery`, and a real Chromium screenshot.

# Part 45 — Canva: catching the invite link for real (v112)

Order #17989 proved the session works (the bot reached People and invited the
email) but ended with "invited, but no link appeared". The link hunt was
rebuilt around three independent sources:

* **Network** — every JSON/text response Canva's app receives is scanned for a
  `canva.com/brand/join?…` URL (JSON-escaped `\/` and `\u0026` handled). The
  invite API reply usually carries it, with no dependence on button labels.
* **Copy hook** — an init script wraps `navigator.clipboard.writeText/write`,
  `execCommand('copy')` and the copy event, so whatever a "Copy link" button
  copies is recorded (headless Chromium cannot read the clipboard back).
* **DOM + pending-invite menu** — inputs/hrefs/text, and the invited row's
  "…" → "Copy invite link".

**Public-link guard (owner's hard rule):** join links seen before the email is
typed (page load, invite dialog) are the team's shared link and are never
accepted; a link already delivered to a different email is rejected too. A
doubtful case goes to manual instead of leaking.

**Failure report:** the admin gets the Canva screenshot, the visible buttons
and the (masked) links seen, plus "Already invited — do NOT invite again" so
the customer does not get two emails. Also stored as `canva_last_failure`.

Tested with real Chromium through the full `inviteEmail()` against a fake
Canva page: link in the network reply; link only behind "…" → Copy invite
link; only the team link available (refused, no leak); reused-link rejection.

# Part 46 — Canva invite rebuilt on the real People page (v113)

The v112 failure screenshot (order #17991) showed Canva's real page and a bug
that made every earlier "invited" report false:

* **The search box was used as the invite box.** Its placeholder is "Search
  members by name or email", which matched `input[placeholder*=email]`, so the
  bot typed the customer's email into SEARCH and never opened the invite
  window. Orders #17989/#17991 were most likely never invited. The invite box is
  now only an input inside the `[role=dialog]` opened by "Invite people".
* **Invite is verified**: after Send, the email is searched and a pending row
  ("Invite is valid…" / Resend · Copy link) must exist. Send clicked but no row
  → `invited: 'maybe'` (owner checks People before inviting again).
* **Link from the row's own "Copy link"**, located as the smallest element
  holding this email + "Copy link" + no other email address — another
  customer's pending link (e.g. the row above) can never be clicked. The v112
  page-wide "Copy link" fallback, which could have hit another row, is gone.
* **Cookie banner** ("Accept all cookies") is accepted first; it covered the
  lower rows. Saved with the session so it appears once.
* **Already pending** → its existing link is reused, no second invite email.
  **Already a member** → no invite, clear reason. Search not listing invites →
  falls back to the full list.
* Failure alert now says which: "Already invited — do NOT invite again",
  "May already be invited — check first", or "Not invited yet".
* Tested with real Chromium on a fake page copying the real layout: banner,
  "…or email" search box, another customer's pending row with its own Copy
  link, members, invite dialog with the team link. 7 scenarios incl. reuse,
  member, broken Send, team-link and reused-link refusal.

* **Matched to the real invite window** (owner's screenshot): "Invite people
  to your team" · suggested-people chips · [Get invite link] · OR · email rows
  "Enter email address…" + role · [Confirm and invite]. The confirm button is
  matched by its exact label; the loose "any invite/send button" fallback is
  gone because it could have hit **Get invite link**, which creates the team's
  public link. No Enter key (several address rows). Dialog found by
  `role=dialog` or, failing that, by its heading.
* Links count only if they appear AFTER clicking the customer's row "Copy
  link"; everything seen before (incl. a team link in the Send reply) is
  baseline. Tested: 10 scenarios; "Get invite link" clicked 0 times.

# Part 47 — the real "Invite sent!" step, and a network-link race closed (v114)

The owner's screenshots showed the step after "Confirm and invite" that v113
didn't know about: Canva shows **"Invite sent! Follow up with a unique
link?"** with the customer's own email and a **Copy link** button, then
**Done**. This is now the primary source — no need to search People at all —
and only trusted when that step shows THIS email (Canva lowercases it) and no
"Get invite link" button. Falls back to the People-row Copy link (v113's path)
if the step doesn't appear, shows a different email, or gives nothing.

**Race condition closed.** Testing found a way the public team link could
still leak: if Canva's "Confirm and invite" network reply happened to carry
the team link and the code read it a moment after the Copy-link click, it
looked "new" and would have been delivered. Fixed three ways:
* a network link only counts if its **request** started after the click (not
  when the reply was read) — closes the timing race directly;
* a link the click's own copy action produced is trusted first, network second;
* any link ever seen as a team/baseline link is now **permanently banned**
  (stored in agent state), so it can never be delivered on ANY later order,
  even a fresh browser session.

Tested: 12 scenarios with real Chromium, including the exact race (team link
in the Send reply, every "Copy" silent) and the permanent ban surviving into
a new invite. "Get invite link" clicked 0 times throughout.

# Part 48 — ChatGPT Business ↔ ChatGPT Business Guard integration (v115)

Wires this bot's ChatGPT Business Guard bot to the separate ChatGPT Business
Guard service, so a paid seat is invited and activated automatically instead
of the admin inviting by hand in Canva... in ChatGPT Business Admin, then
tapping "Activate & Notify Customer" once they notice it worked.

* **Outbound** (`services/cgbGuard.js`): right after a ChatGPT Business order
  is confirmed (both the regular and CryptoBot payment paths), the customer's
  email is POSTed to the guard's `/auto-invite`, joining its normal 10-minute
  batch queue — completely optional, a silent no-op until `GUARD_SECRET` and
  `GUARD_AUTO_INVITE_URL` are set. Never throws: the guard being briefly
  unreachable must not break payment confirmation.
* **Inbound** (`POST /webhook/cgb-guard-status`, mounted only when
  `GUARD_SECRET` is set): the guard calls this back once a batch is verified
  in Pending invites (or fails). On success, the matching pending seat is
  found by email and activated automatically — same effect as the manual
  "🔔 Activate & Notify Customer" button. On failure, the admin is alerted
  with the reason instead, and the seat is left untouched.
* **Shared logic extracted**: `activateAndNotifySeat(orderId)` in
  `chatgpt-bot.js` now derives everything (customer id, days, expiry) from
  the database instead of a callback_data string, so both the manual button
  and the webhook activate a seat identically. It also survives the customer
  having blocked the bot (the seat still activates; only the DM fails).
* **`cgb_admin_cards` table** remembers each order's admin card (chat +
  message id) so an automatic activation repaints the SAME red card green,
  instead of only sending a separate confirmation. Falls back to a fresh
  message when no card was saved (e.g. a hand-added `/addseat`).
* Tested: 13 cases against the real `chatgpt-bot.js` (with only
  better-sqlite3/node-telegram-bot-api mocked — native compilation is
  unavailable in this sandbox) plus `services/cgbGuard.js` in isolation:
  successful activation with and without a saved card, already-active
  no-op, unknown order, a blocked customer, disabled-by-default, and the
  full webhook success/failure/unmatched/unauthorized paths.

# Part 49 — Yamen: autonomous crediting for small verified deposits, deduct balance, CGB seat lookup (v116)

Three additions to Yamen ("services/agentTools.js" + "services/agentChat.js"),
plus a settings toggle in the app (🧠 → settings):

* **`auto_credit_verified_deposit`** — for the exact scenario in the shop's
  own transcripts (a customer's transfer arrived, matched nothing automatic,
  small amount): Yamen may credit it AND reply to the customer with no owner
  tap, but ONLY when:
  - the owner has turned this on (off by default — a new switch next to
    auto-reply in the app),
  - Binance ITSELF confirms the TxID/Pay id (the same check as "check this
    txid" — never the model's or the customer's claim),
  - the verified amount is within `AGENT_AUTO_CREDIT_CAP` (default $10),
  - a rolling 24h total stays within `AGENT_AUTO_CREDIT_DAILY_CAP` (default
    $30) — a circuit breaker so a bug or an unusual run of deposits can't
    silently add up past what was intended,
  - the TxID was never used before.
  Every one of these is enforced in CODE, not left to the model's judgment.
  Any check failing falls back to a normal `propose_credit` draft instead of
  refusing outright — the tool is useful either way. The customer-facing
  message is a FIXED template, never model-authored text. The owner gets a
  Telegram alert after every autonomous credit — never silent.
* **`propose_debit`** — the reverse of `propose_credit` (a correction, balance
  given by mistake): same cap, same owner tap to confirm. Refuses instead of
  going negative.
* **`cgb_new_seats_since`** — every ChatGPT Business seat created since a
  date (default 2026-09-26): email, cycle start/end, days left, status —
  so "what came in since the 26th" or "who's expiring soon" can be answered
  directly.
* Standing instruction added: after a manual deposit correction, Yamen now
  always reminds the customer to follow the deposit steps exactly next time.

Tested (16 new cases): the full money-safety matrix (gate off, real credit,
duplicate TxID rejected, over the per-transaction cap, the daily cap kicking
in after several valid small deposits, not found on Binance, a Binance Pay
match, unknown customer, and confirming the tool has no "amount" input at
all so the model can never supply the credited figure) plus propose_debit,
the performAction "debit" execution, and cgb_new_seats_since's date
filtering and sort order.

# Part 50 — "❌ Cancel order" on ChatGPT Business order cards (v117)

For a customer who asks for a refund before their seat is activated.

* The red (and blue "paid early") admin card now has **❌ Cancel order** under
  Activate. It never cancels on one tap: it opens a confirm step with
  **💰 Cancel + refund $X to wallet**, **🚫 Cancel only (refunded outside)**
  and **↩️ Back**.
* Cancelling flips the seat to `cancelled` with a conditional update first —
  if it was activated a moment earlier (e.g. by the invite bot's callback)
  nothing is refunded. The wallet refund goes through the shop's own
  all-or-nothing `refundWallet` under ref `cgb_cancel_<order>`, so a double
  tap can never refund twice. The order is marked cancelled, the customer is
  told, and the card turns grey (⬛ CANCELLED).
* **Invite bot**: the email is pulled out of its queue (new `/cancel-invite`
  endpoint there, same shared secret) so no seat is bought for a refunded
  order. If it was already being processed or already invited, the card says
  so and tells you to revoke it in ChatGPT.
* A cancelled order can never be activated again — not by an old Activate
  button, not by the invite bot reporting success. Cancelled seats are left
  out of the auto-activation lookup and of the revenue totals.
* Tested: the full cancel flow on the real chatgpt-bot.js (confirm step, back,
  wallet refund, double tap, cancel-only, active seat refused, activation race,
  invite bot busy), the SQL on a real SQLite engine, the new invite-bot SQL on
  a real PostgreSQL, and both ends of the bot-to-bot call.

# Part 51 — /guardtest: see exactly why the two bots aren't talking (v118)

"Nothing happened in the invite bot" looked the same for every cause: a
missing or misspelled variable silently disabled the integration, with not
even a log line.

* Startup log now says `[cgbGuard] integration ON → <url>` or
  `integration OFF — missing: GUARD_AUTO_INVITE_URL, GUARD_SECRET`.
* **/guardtest** (ChatGPT Business bot, admin only, in the ☰ menu) checks the
  whole DIGITRUST → invite-bot link WITHOUT queueing anyone or buying
  anything, and answers in plain words: variable missing, address not a URL,
  invite bot unreachable, secret mismatch, panel not ready, invite bot too old,
  or ✅ ready. It uses /cancel-invite with an address that can never be queued.
* The invite bot's matching **/digitrusttest** checks the other direction
  (green cards). DIGITRUST answers that test address with OK and touches no
  order.
* Tested with the real invite-bot web server and the real DIGITRUST endpoint,
  both directions, five situations each.

# Part 52 — GUARD_AUTO_INVITE_URL copy-paste mistakes (v119)

A real case: every paid order logged `[cgbGuard] could not reach the guard
bot … Invalid URL` — the variable was set, but not a valid address.

* The value is now cleaned up automatically when the mistake is obvious:
  surrounding quotes/spaces, missing `https://`, or only the domain (then
  `/auto-invite` is added).
* If it still isn't a valid address (e.g. the example's `<…>` copied
  literally), the startup log says `integration OFF — GUARD_AUTO_INVITE_URL
  is not a valid address: "…"`, each order logs the same instead of a bare
  "Invalid URL", and /guardtest shows the exact value and what it must look
  like.

# Part 53 — Canva: the customer's own link was being thrown away (v120)

"The invite goes out but the bot finds no link to send": caused by the V114
protection against leaking the team's public link. That rule treated EVERY
join link seen before the "Copy link" click as a team link and banned it
forever. Canva's reply to "Confirm and invite" carries the customer's own
link (that's how the "Invite sent!" window knows it), so the bot banned the
customer's link a second early, then rejected it when "Copy link" produced
exactly that link → "invited, but the link could not be copied".

* Links are now judged by WHEN their request started: before Confirm (page
  load, invite window) → team link, banned as before; after Confirm → kept
  aside, not banned; after the Copy click → candidate.
* A link is still only delivered if this customer's own "Copy link" copied
  it (or a request made after that click returned it), so a team link that
  shows up in the Confirm reply still never reaches a customer.
* The old ban list (`canva_team_links`) is no longer read — it holds
  customers' own links banned by the old rule. New list: `canva_team_links_v2`.
* Tested on the fake Canva page, which now sends the customer's link in the
  Confirm reply like the real site: the V119 code fails exactly like
  production ("invited, but the link could not be copied"), the new code
  delivers it; the team-link-in-reply scenarios were rerun with properly
  escaped JSON (the old fake's escaping had hidden those links from the bot
  entirely) and the team link is still never delivered. All 13 scenarios pass.

# Part 54 — Yamen reads the ChatGPT Business workspace (v121)

* **cgb_workspace_report** (new Yamen tool): the invite bot's workspace
  (members, pending invites, whitelist, invite queue — via its new read-only
  `/api/report`) already JOINED in code with every DIGITRUST seat (order,
  start, end, days left, customer, number of orders). Returns ready-made
  lists: expired but still inside, cancelled but still inside, paid but not
  inside, failed invites, inside but not whitelisted, ending soon, invited not
  accepted, inside with no subscription. With `email`: one person in detail
  plus their order history. If the invite bot can't be reached it says so and
  answers from DIGITRUST data only.
* Why: "Yamen seems dumb" came mostly from the cheap model stitching raw lists
  from several tools. The joining is now done in code; the model only reads
  and explains. Questions about subscriptions, emails, dates and "why" now get
  more thinking on the cheap model; "تقارير" joins the report words that use
  the strong model.
* Tested on realistic mixes (all flag types, the owner never flagged, any-case
  email lookup, latest seat of a repeat customer, invite bot unreachable), the
  SQL on real SQLite, and against the real invite-bot /api/report endpoint.

# Part 55 — Yamen reads the owner's personal private chats (v122)

With Telegram Premium, the owner connects the store bot to his own account
(Telegram → Settings → Telegram Business → Chatbots). Telegram's official
mechanism: no password, disconnect any time from the same screen. (BotFather
→ the store bot → Bot Settings → Business Mode must be ON for it to appear.)

* services/businessInbox.js receives `business_connection` / `business_message`.
  Only a connection made by the OWNER's account is accepted; anyone else who
  connects this bot is ignored. Text only is stored (media as [photo] etc.),
  30 days, in `business_messages`.
* Yamen tools: business_inbox (who is waiting in your private chats and for
  how long, and whether a reply is allowed now — Telegram only allows one
  within 24h of their last message), business_thread (one chat),
  propose_business_reply (a card; sent AS THE OWNER only when he taps).
  No auto-reply in personal chats.
* agentWatch: "📥 X wrote to you privately N minutes ago" alerts, same
  wait-minutes setting as the support inbox.
* These messages never reach the shop's normal command handlers (the Telegram
  library routes them to a separate event).
* Tested on a real SQLite engine (sql.js): stranger connection ignored, owner
  connection saved and confirmed, inbox/waiting logic, @username lookup,
  prepare → tap → sent as the owner, no-permission and 24h refusals, and the
  alert query.

# Part 56 — a separate bot for the owner's private chats (v123)

* `BUSINESS_BOT_TOKEN` (optional): a dedicated bot used ONLY for Telegram
  Business (the owner's personal private chats), so the store bot stays for
  customers and the two never mix. It answers nobody but the owner: /start
  from him explains how to connect it (or says it is connected); anyone
  else gets no reply. Replies Yamen prepares go out through this bot, as the
  owner, only when he taps.
* The store bot still works as before if no dedicated bot is set.
* Tested: no token → nothing starts; stranger /start → silence; owner /start
  → instructions / "connected"; connection saved on the dedicated bot; a
  reply is sent through it and the store bot sends nothing.

# Part 57 — Yamen in private chats: knows who he's talking to, writes like the owner (v124)

In private chats Yamen writes AS the owner, so mistakes cost the most there.

* business_thread now also returns `person`: in a 1-to-1 chat the chat id IS
  the person's Telegram id, so a shop customer is recognised automatically —
  balance, rank, recent orders, ChatGPT seats with days left. business_inbox
  marks which waiting chats are customers.
* `your_recent_replies`: a sample of the owner's OWN recent private messages
  (never anyone else's) as a style guide, so drafts match his length, tone
  and emoji habits.
* A private-chat playbook in Yamen's instructions: read the thread first; sort
  the chat into sale / support / personal / suspicious; check live facts
  (stock, price, order, seat) before stating them; never invent prices, dates
  or promises; don't draft for personal or suspicious chats (warn instead);
  one card per chat; batch "draft replies for everyone waiting".
* Private-chat requests now use the strong model (they are rarer and matter
  more). Keep an eye on the daily budget in the app (🧠 → 🔔 → 💸).
* Tested on real SQLite: customer context, stranger → "not a customer",
  style sample = owner only, inbox customer flags, and the model routing.

# Part 58 — private chats always promote the shop bot (v125)

* Standing rule in Yamen's private-chat playbook: the owner always wants to
  grow the shop bot. In every sale and support chat (never personal or
  suspicious ones) a draft invites the person to order through the bot with
  the REAL link and one short reason that fits (instant delivery, wallet,
  24/7, history and warranty in one place) — once per reply, natural, never
  pushy. ChatGPT Business questions → the ChatGPT bot; order problems → support.
* business_thread returns `shop`: the store bot's real @username (read with
  getMe at startup), CHATGPT_BOT_USERNAME and SUPPORT_BOT_USERNAME. A link that
  isn't configured stays empty; Yamen is told never to invent one.

# Part 59 — an empty private inbox is explained, not just "nothing" (v126)

The owner saw unread badges (12, 4, 1) while Yamen said there were no chats.
Telegram only forwards messages that arrive AFTER the business connection, and
only 1-to-1 chats with people (not groups, channels or other bots) — so older
unread messages are invisible to the bot. business_inbox now returns
`connected_since_utc`, `messages_received_total`, `last_message_received_utc`
and a `note`, and Yamen is told to explain an empty inbox with those facts.

# Part 60 — Yamen: new look, activation counter, learns nightly, better voice (v127)

* **New design** ("Sidi Bou Said at night"): deep sea-blue base, cobalt for the
  owner's messages and main actions, jasmine amber only for things waiting on
  him; IBM Plex Sans Arabic; no gradient washes — cards are told apart by a
  coloured edge (cobalt = a reply to approve, green = stock/action, amber =
  alert). Cards and notes follow their text's own direction, so Arabic lines
  no longer come out in scrambled word order. Every id/class is unchanged,
  so all features keep working. Reviewed from real renders at phone size.
* **Live ChatGPT activation counter** under the header: how many paid seats
  are waiting to be activated and a ticking timer for the oldest; tap it to
  ask Yamen for the list. Paid-early seats (period starts later) are counted
  apart. Endpoint `/agent/cgb-waiting`. Plus an alert when one waits longer
  than the "wait minutes" setting. Replaces the old count pill.
* **Learns every night** (23:30 by default): re-reads the day's conversation
  with the owner and saves up to 6 lessons with the normal memory tool — his
  corrections, rules, how the business works, and misheard words (category
  `vocab`). Skips quiet days; once per night; never saves secrets or other
  people's messages; every lesson is visible/deletable in the memory screen.
  He also saves a lesson immediately whenever the owner corrects him.
* **Voice**: speech-to-text now uses the most accurate model first
  (gpt-4o-transcribe) with a hint written the way the owner talks (Derja in
  Arabic script + French/English shop words) plus real product names and the
  learned `vocab` words. Text-to-speech was ~20% too fast (speed 1.1 +
  "quick, lively" + the app speeding playback up again): now speed 0.95,
  "calm, clear, unhurried", normal playback.

# Part 61 — Yamen becomes an app: side navigation and a Private chats section (v128)

* **App shell** (right-to-left): a side navigation — يمان (the assistant
  chat), المحادثات الخاصة, تفعيلات ChatGPT, التنبيهات, الذاكرة والإعدادات —
  with live badges. Persistent on desktop (≥900px); on a phone it slides in
  from ☰ over a dimmed background. Sections cross-fade; reduced motion is
  respected; the last section is remembered.
* **Private chats** (Telegram Business) as a real messaging view: chat list
  with avatars, "customer" tag, last message and a jasmine "waiting 35 m"
  pill; the open chat shows who they are (balance, last order, ChatGPT days
  left), the conversation, and a composer with **✨ suggest** (Yamen writes a
  reply in your style, with the shop-bot link when it fits, flags scams — the
  text only fills the box) and **➤ send** (goes out as you). Two panes on
  desktop, list → chat on a phone. Telegram's 24h rule is shown before you try.
* **ChatGPT activations** section: each waiting customer with a ticking timer
  and an "ask Yamen" button; **Alerts** section with unread badge.
* API: `GET /agent/business/chats`, `GET /agent/business/thread`,
  `POST /agent/business/suggest` (one tool-free model call, counts toward the
  daily budget, writes nothing to Yamen's chat), `POST /agent/business/send`.
* Reviewed from real renders (desktop 1280 and phone 390): no page errors.
  Tested the endpoints through the real router (token, list, thread, 404,
  suggest sends nothing, send only on ➤).

# Part 62 — Token diet + professional UI pass (v129)

## Tokens: 56–73% less per everyday call
Measured: every call used to send all 56 tool descriptions (~6,900 tokens)
plus every topic's rules (~6,000), ~13,000 tokens before the question itself.
* **Tool groups** (sales, stock, products, posts, support, money, cgb,
  private, web, system). A message gets a small core (lookups, memory) plus
  the groups its words point to, plus the groups of the last 15 minutes (so
  "إيه ابعثو" still works). Yamen loads any other group himself with
  `use_tools`. Anything not in a group stays core, so a new tool is never lost.
* **Instructions split the same way**: a 7.4k-char core (was 19.3k) + topic
  guides sent only with their group. A test checks every line of the old
  instructions still exists somewhere.
* Measured after: greeting ~3,400 (was ~13,000), sales ~3,700, stock ~5,200,
  private ~5,000, TxID ~5,000, daily summary ~9,000.
* Undid the expensive routing added in v124/v127: private-chat words no
  longer force the strong model; the "careful thinking" trigger no longer
  fires on "@", "email", "why"…; ✨ suggestions use the fast model.
* The Responses conversation chain resets at 12k input tokens (was 25k) —
  past that every message re-bills the whole history.
* `prompt_cache_key` on every call so OpenAI reuses its cache for the
  unchanging start (dropped automatically if a model rejects it).
* Nightly learning gets the core only (its transcript no longer drags in
  every tool group).

## UI
* One consistent line-icon set replaces every emoji icon (menu, call, sound,
  new chat, attach, mic, send/stop, refresh, back, suggest, nav).
* Yamen's replies are written straight on the page, full width of a centred
  760px reading column, aligned by their own language; only the owner's
  messages are bubbles.
* One unified composer bar (attach · text · mic · send) in both chats.
* Budget meter in the sidebar (spent / daily cap, model, memory count).
* "@name" keeps the @ in front inside Arabic sentences (alerts and replies).
* Reviewed from real renders, desktop and phone; no page errors.

# Part 63 — Yamen's app, premium layer: depth, light and motion (v130)

"Not professional — make it fluid and beautiful." v129 fixed the structure;
this pass changes the feel. CSS only; no behaviour changed.
* Depth instead of borders: frosted-glass sidebar, headers, cards and
  composer floating over a deep night-sea background with a soft cobalt and
  turquoise glow.
* One signature gradient (cobalt → sea turquoise) used only for the owner's
  messages, the send button, the active section and Yamen's mark/label.
* The waiting counter is now a capsule with a pulsing amber halo instead of
  a solid bar; waiting private chats get an amber ring on the avatar.
* Motion that answers: messages and cards float in with a light spring,
  sections glide, the settings sheet rises, buttons give way when pressed;
  all off under "reduce motion".
* Suggestion chips appear only on an empty chat.
* Fixed during review: the capsule's styles leaked onto waiting chat rows
  (shared class name) — now scoped to the capsule.
* Reviewed from real renders on desktop and phone; no page errors.
