'use strict';

// ─── Translations for 4 languages ─────────────────────────────────────
// en = English, ar = Arabic, vi = Vietnamese, es = Spanish

const translations = {
  en: {
    // Language picker
    pick_language: '🌐 <b>Welcome!</b>\n\nPlease choose your language:',
    language_set: '✅ Language set to English',
    lang_english: '🇬🇧 English',
    lang_arabic: '🇸🇦 العربية',
    lang_vietnamese: '🇻🇳 Tiếng Việt',
    lang_spanish: '🇪🇸 Español',

    // Main menu
    main_menu_title: '🏠 <b>Main Menu</b>',
    btn_products: '🛍 Products',
    btn_preorders: '🔜 Pre-Orders',
    btn_wallet: '💰 Wallet',
    btn_orders: '📦 My Orders',
    btn_support: '💬 Support',
    btn_referral: '👥 Referral',
    btn_vip: '👑 VIP',
    btn_refunds: '🔄 Refund Request',
    welcome_greeting: '🛍 <b>Welcome to {store}</b>{greeting}!',
    welcome_choose: 'Choose an option below:',
    btn_language: '🌐 Language',

    // Common buttons
    btn_back: '🔙 Back',
    btn_cancel: '❌ Cancel',
    btn_confirm: '✅ Confirm',
    btn_yes: '✅ Yes',
    btn_no: '❌ No',

    // Products
    products_title: '🛍 <b>Our Products</b>',
    no_products: 'No products available at the moment.',
    out_of_stock: '❌ Out of Stock',
    buy_now: '🛒 Buy Now',
    notify_back: '🔔 Notify me when back in stock',
    you_will_be_notified: '✅ You will be notified when this product is back in stock.',

    // Pre-orders
    preorder_title: '🔜 <b>Pre-Order Products</b>',
    preorder_intro: 'Reserve your spot — pay now, receive when stock arrives.',
    no_preorders: 'No pre-order products available at the moment.',
    preorder_reserve: '🔜 Reserve Pre-Order',
    preorder_full: '❌ All slots reserved',
    preorder_enter_qty: 'Enter the quantity you want to reserve',
    preorder_enter_email: '📧 Please enter your email for delivery:',
    preorder_confirm: '🔜 <b>Confirm Pre-Order</b>',
    preorder_confirmed: '✅ <b>Pre-Order Confirmed!</b>',
    preorder_cancelled: '❌ Pre-order cancelled.',

    // Buy flow
    buy_enter_qty: '🔢 Enter quantity:',
    buy_enter_email: '📧 Enter your email for delivery:',
    buy_invalid_qty: '❌ Please enter a valid number.',
    buy_invalid_email: '❌ Please enter a valid email.',
    order_summary: '🧾 <b>Order Summary</b>',
    insufficient_balance: '❌ <b>Insufficient balance!</b>',

    // Wallet
    wallet_title: '💰 <b>Your Wallet</b>',
    wallet_balance: 'Balance',
    wallet_topup: '💳 Top Up Wallet',
    wallet_transactions: '📜 Transactions',

    // Orders
    orders_title: '📦 <b>My Orders</b>',
    no_orders: 'You have no orders yet.',

    // Support
    support_title: '💬 <b>Support</b>',
    support_send_msg: '📝 Send Message',

    // Referral
    referral_title: '👥 <b>Referral Program</b>',
    referral_link: 'Your link',
    referral_total: 'Total Referrals',
    referral_earned: 'Total Earned',

    // Errors
    error_generic: '❌ Something went wrong. Please try again.',
    error_session_expired: '❌ Session expired. Please try again.',

    // Payment Confirmed
    payment_confirmed: '✅ <b>Payment Confirmed!</b>',
    purchase_date: 'Purchase Date',
    your_products: '🎁 <b>Your Product(s):</b>',
    thank_you: '✨ Thank you! Use /start → My Orders to re-view anytime.',

    // Wallet - Top Up
    wallet_choose_method: '💳 <b>Choose Top-Up Method</b>',
    wallet_btn_usdt_bep20: '💎 USDT (BEP20)',
    wallet_btn_usdt_trc20: '💎 USDT (TRC20)',
    wallet_btn_binance_pay: '🟡 Binance Pay',
    wallet_btn_cryptobot: '🤖 CryptoBot',
    wallet_enter_amount: '💵 Enter the amount you want to top up (in USDT):',
    wallet_min_deposit: '❌ Minimum deposit is <b>{min} USDT</b>.',
    wallet_send_txid: '📋 Send your <b>TxID / Transaction Hash</b> after paying:',
    wallet_send_orderid: '📋 Send your <b>Binance Pay Order ID</b> after paying:',
    wallet_verifying: '⏳ <b>Verifying your deposit…</b>\n\nThis may take up to 30 seconds.',
    wallet_verified: '✅ <b>Deposit Confirmed!</b>\n\n💵 Amount: <b>${amount} USDT</b> has been added to your wallet.',
    wallet_invalid_txid: '❌ Invalid TxID format. Please send a valid transaction hash.',
    wallet_already_used: '❌ <b>This TxID has already been used.</b>',
    wallet_already_processing: '⏳ Already being verified. Please wait...',
    wallet_timeout: '⚠️ <b>Verification timed out.</b>\n\nPlease try again in a moment.',
    wallet_topup_expired: '⏰ <b>This top-up request has expired.</b>\n\nIt was valid for {minutes} minutes. Please start a new top-up.',
    wallet_not_found: '❌ <b>Deposit not found.</b>\n\nMake sure you sent to the correct address and try again.',
    wallet_topup_success: '✅ <b>Wallet Topped Up!</b>\n\n💵 <b>{amount} USDT</b> added to your balance.',

    // Payment methods
    pay_select: '💳 <b>Select Payment Method</b>',
    pay_wallet_label: '💰 Pay with Wallet',
    pay_binance_label: '🟡 Binance Pay',
    pay_usdt_label: '💎 USDT',
    pay_cryptobot_label: '🤖 CryptoBot',
    pay_wallet_insufficient: '❌ <b>Insufficient balance!</b>\n\n💰 Balance: <b>{balance}</b>\n💵 Required: <b>{required}</b>\n\nPlease top up your wallet first.',
    pay_out_of_stock: '❌ <b>Out of Stock</b>\n\nSorry, this product just sold out.\n\n<i>No payment was taken.</i>',
    pay_cancelled_oos: '❌ Order cancelled — Out of Stock\n\nNo payment was taken from your wallet.',

    // Binance Pay flow
    binance_instructions: '🟡 <b>Binance Pay</b>\n\n📦 Order #{order}\n💵 Amount: <b>{amount} USDT</b>\n\n1. Open Binance app\n2. Go to Pay → Send\n3. Send exactly <b>{amount} USDT</b> to:\n<code>{address}</code>\n4. Copy your <b>Order ID</b> and send it here.',
    binance_enter_orderid: '📋 Please send your <b>Binance Pay Order ID</b>:',
    binance_verifying: '⏳ <b>Verifying Binance Pay transaction…</b>\n\n<i>This may take up to 30 seconds.</i>',

    // USDT flow
    usdt_instructions: '💎 <b>USDT Payment</b>\n\n📦 Order #{order}\n💵 Amount: <b>{amount} USDT</b>\n\nSend to:\n<code>{address}</code>\n\nThen send your <b>TxID</b> here.',
    usdt_enter_txid: '📋 Please send your <b>Transaction Hash (TxID)</b>:',

    // CryptoBot flow
    cryptobot_instructions: '🤖 <b>Pay with CryptoBot</b>\n\n📦 Order #{order}\n💵 Amount: <b>{amount} USDT</b>\n\n👇 Tap Pay Now — your order delivers automatically.',
    cryptobot_btn_pay: '🤖 Pay Now via CryptoBot',

    // Order delivery
    delivery_title: '✅ <b>Order Delivered!</b>',
    delivery_order: 'Order',
    delivery_product: 'Product',
    delivery_qty: 'Quantity',
    delivery_total: 'Total',
    delivery_method: 'Payment',
    delivery_content: '🎁 <b>Your Product(s):</b>',
    delivery_footer: '✨ Thank you for your purchase! Use /start → My Orders to re-view anytime.',

    // Order status
    order_status_pending: '⏳ Pending',
    order_status_delivered: '✅ Delivered',
    order_status_cancelled: '❌ Cancelled',

    // Refund
    refund_title: '🔄 <b>Refund Request</b>',
    refund_enter_orderid: '📋 Enter your <b>Order ID</b> to request a refund:',
    refund_reason: '📝 Please describe why you are requesting a refund:',
    refund_submitted: '✅ <b>Refund request submitted!</b>\n\nOur team will review it shortly.',
    refund_already: '❌ A refund request already exists for this order.',
    refund_not_eligible: '❌ This order is not eligible for a refund.',

    // Stock alert
    stock_low_alert: '⚠️ Only {count} left in stock!',
    stock_out: '❌ This product is currently out of stock.',
    notify_subscribed: '🔔 You will be notified when this product is back in stock.',
  },

  ar: {
    pick_language: '🌐 <b>أهلاً وسهلاً!</b>\n\nاختر اللغة المفضلة:',
    language_set: '✅ تم تعيين اللغة إلى العربية',
    lang_english: '🇬🇧 English',
    lang_arabic: '🇸🇦 العربية',
    lang_vietnamese: '🇻🇳 Tiếng Việt',
    lang_spanish: '🇪🇸 Español',

    main_menu_title: '🏠 <b>القائمة الرئيسية</b>',
    btn_products: '🛍 المنتجات',
    btn_preorders: '🔜 الحجوزات المسبقة',
    btn_wallet: '💰 المحفظة',
    btn_orders: '📦 طلباتي',
    btn_support: '💬 الدعم',
    btn_referral: '👥 الإحالة',
    btn_vip: '👑 VIP',
    btn_refunds: '🔄 Refund Request',
    welcome_greeting: '🛍 <b>أهلاً بك في {store}</b>{greeting}!',
    welcome_choose: 'اختر من القائمة:',
    btn_language: '🌐 اللغة',

    btn_back: '🔙 رجوع',
    btn_cancel: '❌ إلغاء',
    btn_confirm: '✅ تأكيد',
    btn_yes: '✅ نعم',
    btn_no: '❌ لا',

    products_title: '🛍 <b>منتجاتنا</b>',
    no_products: 'لا توجد منتجات متاحة حالياً.',
    out_of_stock: '❌ نفد المخزون',
    buy_now: '🛒 اشترِ الآن',
    notify_back: '🔔 أبلغني عند توفره',
    you_will_be_notified: '✅ سيتم إبلاغك عند توفر المنتج.',

    preorder_title: '🔜 <b>الحجوزات المسبقة</b>',
    preorder_intro: 'احجز مكانك — ادفع الآن، استلم عند وصول المخزون.',
    no_preorders: 'لا توجد منتجات للحجز المسبق حالياً.',
    preorder_reserve: '🔜 احجز الآن',
    preorder_full: '❌ نفدت كل الأماكن',
    preorder_enter_qty: 'أدخل الكمية التي تريد حجزها',
    preorder_enter_email: '📧 الرجاء إدخال البريد الإلكتروني للتسليم:',
    preorder_confirm: '🔜 <b>تأكيد الحجز</b>',
    preorder_confirmed: '✅ <b>تم تأكيد الحجز!</b>',
    preorder_cancelled: '❌ تم إلغاء الحجز.',

    buy_enter_qty: '🔢 أدخل الكمية:',
    buy_enter_email: '📧 أدخل البريد الإلكتروني للتسليم:',
    buy_invalid_qty: '❌ الرجاء إدخال رقم صحيح.',
    buy_invalid_email: '❌ الرجاء إدخال بريد إلكتروني صحيح.',
    order_summary: '🧾 <b>ملخص الطلب</b>',
    insufficient_balance: '❌ <b>الرصيد غير كافٍ!</b>',

    wallet_title: '💰 <b>محفظتك</b>',
    wallet_balance: 'الرصيد',
    wallet_topup: '💳 شحن المحفظة',
    wallet_transactions: '📜 المعاملات',

    orders_title: '📦 <b>طلباتي</b>',
    no_orders: 'ليس لديك أي طلبات بعد.',

    support_title: '💬 <b>الدعم</b>',
    support_send_msg: '📝 إرسال رسالة',

    referral_title: '👥 <b>برنامج الإحالة</b>',
    referral_link: 'رابطك',
    referral_total: 'إجمالي الإحالات',
    referral_earned: 'إجمالي الأرباح',

    error_generic: '❌ حدث خطأ ما. الرجاء المحاولة مرة أخرى.',
    error_session_expired: '❌ انتهت الجلسة. الرجاء المحاولة مرة أخرى.',

    payment_confirmed: '✅ <b>تم تأكيد الدفع!</b>',
    purchase_date: 'تاريخ الشراء',
    your_products: '🎁 <b>منتجاتك:</b>',
    thank_you: '✨ شكراً لك! استخدم /start ← طلباتي لمراجعتها لاحقاً.',

    wallet_choose_method: '💳 <b>اختر طريقة الشحن</b>',
    wallet_btn_usdt_bep20: '💎 USDT (BEP20)',
    wallet_btn_usdt_trc20: '💎 USDT (TRC20)',
    wallet_btn_binance_pay: '🟡 Binance Pay',
    wallet_btn_cryptobot: '🤖 CryptoBot',
    wallet_enter_amount: '💵 أدخل المبلغ الذي تريد شحنه (بالـ USDT):',
    wallet_min_deposit: '❌ الحد الأدنى للإيداع هو <b>{min} USDT</b>.',
    wallet_send_txid: '📋 أرسل <b>رقم المعاملة (TxID)</b> بعد الدفع:',
    wallet_send_orderid: '📋 أرسل <b>رقم طلب Binance Pay</b> بعد الدفع:',
    wallet_verifying: '⏳ <b>جاري التحقق من الإيداع…</b>\n\nقد يستغرق حتى 30 ثانية.',
    wallet_verified: '✅ <b>تم تأكيد الإيداع!</b>\n\n💵 تمت إضافة <b>{amount} USDT</b> إلى محفظتك.',
    wallet_invalid_txid: '❌ صيغة TxID غير صحيحة. الرجاء إرسال رقم معاملة صحيح.',
    wallet_already_used: '❌ <b>هذا الـ TxID مستخدم مسبقاً.</b>',
    wallet_already_processing: '⏳ جاري التحقق بالفعل. الرجاء الانتظار...',
    wallet_timeout: '⚠️ <b>انتهت مهلة التحقق.</b>\n\nالرجاء المحاولة مرة أخرى.',
    wallet_topup_expired: '⏰ <b>انتهت صلاحية طلب الشحن هذا.</b>\n\nكانت صالحة لمدة {minutes} دقيقة. الرجاء بدء عملية شحن جديدة.',
    wallet_not_found: '❌ <b>لم يتم العثور على الإيداع.</b>\n\nتأكد من إرسالك للعنوان الصحيح وأعد المحاولة.',
    wallet_topup_success: '✅ <b>تم شحن المحفظة!</b>\n\n💵 تمت إضافة <b>{amount} USDT</b> إلى رصيدك.',

    pay_select: '💳 <b>اختر طريقة الدفع</b>',
    pay_wallet_label: '💰 الدفع بالمحفظة',
    pay_binance_label: '🟡 Binance Pay',
    pay_usdt_label: '💎 USDT',
    pay_cryptobot_label: '🤖 CryptoBot',
    pay_wallet_insufficient: '❌ <b>الرصيد غير كافٍ!</b>\n\n💰 رصيدك: <b>{balance}</b>\n💵 المطلوب: <b>{required}</b>\n\nالرجاء شحن محفظتك أولاً.',
    pay_out_of_stock: '❌ <b>نفد المخزون</b>\n\nنأسف، نفد المنتج للتو.\n\n<i>لم يتم خصم أي مبلغ.</i>',
    pay_cancelled_oos: '❌ تم إلغاء الطلب — نفد المخزون\n\nلم يتم خصم أي مبلغ من محفظتك.',

    binance_instructions: '🟡 <b>Binance Pay</b>\n\n📦 طلب #{order}\n💵 المبلغ: <b>{amount} USDT</b>\n\n1. افتح تطبيق Binance\n2. اذهب إلى Pay → إرسال\n3. أرسل بالضبط <b>{amount} USDT</b> إلى:\n<code>{address}</code>\n4. انسخ <b>رقم الطلب</b> وأرسله هنا.',
    binance_enter_orderid: '📋 الرجاء إرسال <b>رقم طلب Binance Pay</b>:',
    binance_verifying: '⏳ <b>جاري التحقق من معاملة Binance Pay…</b>\n\n<i>قد يستغرق حتى 30 ثانية.</i>',

    usdt_instructions: '💎 <b>الدفع بـ USDT</b>\n\n📦 طلب #{order}\n💵 المبلغ: <b>{amount} USDT</b>\n\nأرسل إلى:\n<code>{address}</code>\n\nثم أرسل <b>رقم المعاملة (TxID)</b> هنا.',
    usdt_enter_txid: '📋 الرجاء إرسال <b>رقم المعاملة (TxID)</b>:',

    cryptobot_instructions: '🤖 <b>الدفع عبر CryptoBot</b>\n\n📦 طلب #{order}\n💵 المبلغ: <b>{amount} USDT</b>\n\n👇 اضغط "ادفع الآن" — سيتم التسليم تلقائياً بعد الدفع.',
    cryptobot_btn_pay: '🤖 ادفع الآن عبر CryptoBot',

    delivery_title: '✅ <b>تم التسليم!</b>',
    delivery_order: 'الطلب',
    delivery_product: 'المنتج',
    delivery_qty: 'الكمية',
    delivery_total: 'الإجمالي',
    delivery_method: 'طريقة الدفع',
    delivery_content: '🎁 <b>منتجاتك:</b>',
    delivery_footer: '✨ شكراً لشرائك! استخدم /start ← طلباتي لمراجعتها لاحقاً.',

    order_status_pending: '⏳ قيد الانتظار',
    order_status_delivered: '✅ تم التسليم',
    order_status_cancelled: '❌ ملغى',

    refund_title: '🔄 <b>طلب استرداد</b>',
    refund_enter_orderid: '📋 أدخل <b>رقم الطلب</b> للاسترداد:',
    refund_reason: '📝 الرجاء وصف سبب طلب الاسترداد:',
    refund_submitted: '✅ <b>تم تقديم طلب الاسترداد!</b>\n\nسيقوم فريقنا بمراجعته قريباً.',
    refund_already: '❌ يوجد طلب استرداد مسبق لهذا الطلب.',
    refund_not_eligible: '❌ هذا الطلب غير مؤهل للاسترداد.',

    stock_low_alert: '⚠️ تبقى {count} فقط في المخزون!',
    stock_out: '❌ هذا المنتج غير متوفر حالياً.',
    notify_subscribed: '🔔 ستتلقى إشعاراً عند توفر المنتج.',
  },

  vi: {
    pick_language: '🌐 <b>Chào mừng!</b>\n\nVui lòng chọn ngôn ngữ:',
    language_set: '✅ Đã đặt ngôn ngữ thành Tiếng Việt',
    lang_english: '🇬🇧 English',
    lang_arabic: '🇸🇦 العربية',
    lang_vietnamese: '🇻🇳 Tiếng Việt',
    lang_spanish: '🇪🇸 Español',

    main_menu_title: '🏠 <b>Menu Chính</b>',
    btn_products: '🛍 Sản phẩm',
    btn_preorders: '🔜 Đặt trước',
    btn_wallet: '💰 Ví',
    btn_orders: '📦 Đơn của tôi',
    btn_support: '💬 Hỗ trợ',
    btn_referral: '👥 Giới thiệu',
    btn_vip: '👑 VIP',
    btn_refunds: '🔄 Refund Request',
    welcome_greeting: '🛍 <b>Chào mừng đến {store}</b>{greeting}!',
    welcome_choose: 'Chọn một mục bên dưới:',
    btn_language: '🌐 Ngôn ngữ',

    btn_back: '🔙 Quay lại',
    btn_cancel: '❌ Hủy',
    btn_confirm: '✅ Xác nhận',
    btn_yes: '✅ Có',
    btn_no: '❌ Không',

    products_title: '🛍 <b>Sản phẩm</b>',
    no_products: 'Hiện không có sản phẩm nào.',
    out_of_stock: '❌ Hết hàng',
    buy_now: '🛒 Mua ngay',
    notify_back: '🔔 Thông báo khi có hàng',
    you_will_be_notified: '✅ Bạn sẽ được thông báo khi sản phẩm có hàng trở lại.',

    preorder_title: '🔜 <b>Đặt trước</b>',
    preorder_intro: 'Đặt chỗ trước — thanh toán ngay, nhận khi có hàng.',
    no_preorders: 'Hiện không có sản phẩm đặt trước.',
    preorder_reserve: '🔜 Đặt trước ngay',
    preorder_full: '❌ Đã hết chỗ',
    preorder_enter_qty: 'Nhập số lượng bạn muốn đặt',
    preorder_enter_email: '📧 Vui lòng nhập email để giao hàng:',
    preorder_confirm: '🔜 <b>Xác nhận đặt trước</b>',
    preorder_confirmed: '✅ <b>Đã xác nhận đặt trước!</b>',
    preorder_cancelled: '❌ Đặt trước đã hủy.',

    buy_enter_qty: '🔢 Nhập số lượng:',
    buy_enter_email: '📧 Nhập email để giao hàng:',
    buy_invalid_qty: '❌ Vui lòng nhập một số hợp lệ.',
    buy_invalid_email: '❌ Vui lòng nhập email hợp lệ.',
    order_summary: '🧾 <b>Tóm tắt đơn hàng</b>',
    insufficient_balance: '❌ <b>Số dư không đủ!</b>',

    wallet_title: '💰 <b>Ví của bạn</b>',
    wallet_balance: 'Số dư',
    wallet_topup: '💳 Nạp tiền',
    wallet_transactions: '📜 Giao dịch',

    orders_title: '📦 <b>Đơn của tôi</b>',
    no_orders: 'Bạn chưa có đơn hàng nào.',

    support_title: '💬 <b>Hỗ trợ</b>',
    support_send_msg: '📝 Gửi tin nhắn',

    referral_title: '👥 <b>Chương trình giới thiệu</b>',
    referral_link: 'Liên kết của bạn',
    referral_total: 'Tổng giới thiệu',
    referral_earned: 'Tổng kiếm được',

    error_generic: '❌ Đã xảy ra lỗi. Vui lòng thử lại.',
    error_session_expired: '❌ Phiên đã hết hạn. Vui lòng thử lại.',

    payment_confirmed: '✅ <b>Thanh toán đã xác nhận!</b>',
    purchase_date: 'Ngày mua',
    your_products: '🎁 <b>Sản phẩm của bạn:</b>',
    thank_you: '✨ Cảm ơn bạn! Dùng /start → Đơn của tôi để xem lại.',

    wallet_choose_method: '💳 <b>Chọn phương thức nạp tiền</b>',
    wallet_btn_usdt_bep20: '💎 USDT (BEP20)',
    wallet_btn_usdt_trc20: '💎 USDT (TRC20)',
    wallet_btn_binance_pay: '🟡 Binance Pay',
    wallet_btn_cryptobot: '🤖 CryptoBot',
    wallet_enter_amount: '💵 Nhập số tiền bạn muốn nạp (USDT):',
    wallet_min_deposit: '❌ Nạp tối thiểu <b>{min} USDT</b>.',
    wallet_send_txid: '📋 Gửi <b>Mã giao dịch (TxID)</b> sau khi thanh toán:',
    wallet_send_orderid: '📋 Gửi <b>Mã đơn Binance Pay</b> sau khi thanh toán:',
    wallet_verifying: '⏳ <b>Đang xác minh giao dịch…</b>\n\nCó thể mất đến 30 giây.',
    wallet_verified: '✅ <b>Xác nhận thành công!</b>\n\n💵 Đã cộng <b>{amount} USDT</b> vào ví.',
    wallet_invalid_txid: '❌ Định dạng TxID không hợp lệ.',
    wallet_already_used: '❌ <b>TxID này đã được sử dụng.</b>',
    wallet_already_processing: '⏳ Đang xác minh. Vui lòng chờ...',
    wallet_timeout: '⚠️ <b>Hết thời gian xác minh.</b>\n\nVui lòng thử lại.',
    wallet_topup_expired: '⏰ <b>Yêu cầu nạp tiền này đã hết hạn.</b>\n\nThời hạn là {minutes} phút. Vui lòng bắt đầu nạp tiền mới.',
    wallet_not_found: '❌ <b>Không tìm thấy giao dịch.</b>\n\nKiểm tra địa chỉ và thử lại.',
    wallet_topup_success: '✅ <b>Nạp tiền thành công!</b>\n\n💵 Đã cộng <b>{amount} USDT</b> vào số dư.',

    pay_select: '💳 <b>Chọn phương thức thanh toán</b>',
    pay_wallet_label: '💰 Thanh toán bằng Ví',
    pay_binance_label: '🟡 Binance Pay',
    pay_usdt_label: '💎 USDT',
    pay_cryptobot_label: '🤖 CryptoBot',
    pay_wallet_insufficient: '❌ <b>Số dư không đủ!</b>\n\n💰 Số dư: <b>{balance}</b>\n💵 Cần: <b>{required}</b>\n\nVui lòng nạp thêm tiền.',
    pay_out_of_stock: '❌ <b>Hết hàng</b>\n\nSản phẩm vừa hết hàng.\n\n<i>Không có khoản thanh toán nào được thực hiện.</i>',
    pay_cancelled_oos: '❌ Đơn hàng đã hủy — Hết hàng\n\nKhông trừ tiền từ ví của bạn.',

    binance_instructions: '🟡 <b>Binance Pay</b>\n\n📦 Đơn #{order}\n💵 Số tiền: <b>{amount} USDT</b>\n\n1. Mở app Binance\n2. Vào Pay → Gửi\n3. Gửi đúng <b>{amount} USDT</b> đến:\n<code>{address}</code>\n4. Sao chép <b>Mã đơn hàng</b> và gửi tại đây.',
    binance_enter_orderid: '📋 Vui lòng gửi <b>Mã đơn Binance Pay</b>:',
    binance_verifying: '⏳ <b>Đang xác minh Binance Pay…</b>\n\n<i>Có thể mất đến 30 giây.</i>',

    usdt_instructions: '💎 <b>Thanh toán USDT</b>\n\n📦 Đơn #{order}\n💵 Số tiền: <b>{amount} USDT</b>\n\nGửi đến:\n<code>{address}</code>\n\nSau đó gửi <b>TxID</b> tại đây.',
    usdt_enter_txid: '📋 Vui lòng gửi <b>Mã giao dịch (TxID)</b>:',

    cryptobot_instructions: '🤖 <b>Thanh toán qua CryptoBot</b>\n\n📦 Đơn #{order}\n💵 Số tiền: <b>{amount} USDT</b>\n\n👇 Nhấn Thanh toán — đơn hàng giao tự động.',
    cryptobot_btn_pay: '🤖 Thanh toán qua CryptoBot',

    delivery_title: '✅ <b>Đã giao hàng!</b>',
    delivery_order: 'Đơn hàng',
    delivery_product: 'Sản phẩm',
    delivery_qty: 'Số lượng',
    delivery_total: 'Tổng cộng',
    delivery_method: 'Thanh toán',
    delivery_content: '🎁 <b>Sản phẩm của bạn:</b>',
    delivery_footer: '✨ Cảm ơn! Dùng /start → Đơn của tôi để xem lại.',

    order_status_pending: '⏳ Đang chờ',
    order_status_delivered: '✅ Đã giao',
    order_status_cancelled: '❌ Đã hủy',

    refund_title: '🔄 <b>Yêu cầu hoàn tiền</b>',
    refund_enter_orderid: '📋 Nhập <b>Mã đơn hàng</b> để yêu cầu hoàn tiền:',
    refund_reason: '📝 Mô tả lý do yêu cầu hoàn tiền:',
    refund_submitted: '✅ <b>Đã gửi yêu cầu hoàn tiền!</b>\n\nĐội ngũ sẽ xem xét sớm.',
    refund_already: '❌ Đã có yêu cầu hoàn tiền cho đơn này.',
    refund_not_eligible: '❌ Đơn này không đủ điều kiện hoàn tiền.',

    stock_low_alert: '⚠️ Chỉ còn {count} sản phẩm!',
    stock_out: '❌ Sản phẩm này hiện hết hàng.',
    notify_subscribed: '🔔 Bạn sẽ được thông báo khi có hàng.',
  },

  es: {
    pick_language: '🌐 <b>¡Bienvenido!</b>\n\nElige tu idioma:',
    language_set: '✅ Idioma establecido a Español',
    lang_english: '🇬🇧 English',
    lang_arabic: '🇸🇦 العربية',
    lang_vietnamese: '🇻🇳 Tiếng Việt',
    lang_spanish: '🇪🇸 Español',

    main_menu_title: '🏠 <b>Menú Principal</b>',
    btn_products: '🛍 Productos',
    btn_preorders: '🔜 Pre-Pedidos',
    btn_wallet: '💰 Cartera',
    btn_orders: '📦 Mis Pedidos',
    btn_support: '💬 Soporte',
    btn_referral: '👥 Referidos',
    btn_vip: '👑 VIP',
    btn_refunds: '🔄 Refund Request',
    welcome_greeting: '🛍 <b>Bienvenido a {store}</b>{greeting}!',
    welcome_choose: 'Elige una opción a continuación:',
    btn_language: '🌐 Idioma',

    btn_back: '🔙 Atrás',
    btn_cancel: '❌ Cancelar',
    btn_confirm: '✅ Confirmar',
    btn_yes: '✅ Sí',
    btn_no: '❌ No',

    products_title: '🛍 <b>Nuestros Productos</b>',
    no_products: 'No hay productos disponibles en este momento.',
    out_of_stock: '❌ Sin Stock',
    buy_now: '🛒 Comprar Ahora',
    notify_back: '🔔 Avísame cuando vuelva',
    you_will_be_notified: '✅ Te avisaremos cuando esté disponible.',

    preorder_title: '🔜 <b>Pre-Pedidos</b>',
    preorder_intro: 'Reserva tu lugar — paga ahora, recibe cuando llegue.',
    no_preorders: 'No hay pre-pedidos disponibles.',
    preorder_reserve: '🔜 Reservar Pre-Pedido',
    preorder_full: '❌ Todos los lugares reservados',
    preorder_enter_qty: 'Ingresa la cantidad que quieres reservar',
    preorder_enter_email: '📧 Por favor ingresa tu email:',
    preorder_confirm: '🔜 <b>Confirmar Pre-Pedido</b>',
    preorder_confirmed: '✅ <b>¡Pre-Pedido Confirmado!</b>',
    preorder_cancelled: '❌ Pre-pedido cancelado.',

    buy_enter_qty: '🔢 Ingresa la cantidad:',
    buy_enter_email: '📧 Ingresa tu email para entrega:',
    buy_invalid_qty: '❌ Por favor ingresa un número válido.',
    buy_invalid_email: '❌ Por favor ingresa un email válido.',
    order_summary: '🧾 <b>Resumen del Pedido</b>',
    insufficient_balance: '❌ <b>¡Saldo insuficiente!</b>',

    wallet_title: '💰 <b>Tu Cartera</b>',
    wallet_balance: 'Saldo',
    wallet_topup: '💳 Recargar',
    wallet_transactions: '📜 Transacciones',

    orders_title: '📦 <b>Mis Pedidos</b>',
    no_orders: 'No tienes pedidos todavía.',

    support_title: '💬 <b>Soporte</b>',
    support_send_msg: '📝 Enviar mensaje',

    referral_title: '👥 <b>Programa de Referidos</b>',
    referral_link: 'Tu enlace',
    referral_total: 'Total Referidos',
    referral_earned: 'Total Ganado',

    error_generic: '❌ Algo salió mal. Por favor intenta de nuevo.',
    error_session_expired: '❌ Sesión expirada. Por favor intenta de nuevo.',

    payment_confirmed: '✅ <b>¡Pago Confirmado!</b>',
    purchase_date: 'Fecha de compra',
    your_products: '🎁 <b>Tus Productos:</b>',
    thank_you: '✨ ¡Gracias! Usa /start → Mis Pedidos para revisarlos.',

    wallet_choose_method: '💳 <b>Elige el método de recarga</b>',
    wallet_btn_usdt_bep20: '💎 USDT (BEP20)',
    wallet_btn_usdt_trc20: '💎 USDT (TRC20)',
    wallet_btn_binance_pay: '🟡 Binance Pay',
    wallet_btn_cryptobot: '🤖 CryptoBot',
    wallet_enter_amount: '💵 Ingresa el monto a recargar (en USDT):',
    wallet_min_deposit: '❌ El depósito mínimo es <b>{min} USDT</b>.',
    wallet_send_txid: '📋 Envía tu <b>TxID / Hash de transacción</b> después de pagar:',
    wallet_send_orderid: '📋 Envía tu <b>ID de orden Binance Pay</b> después de pagar:',
    wallet_verifying: '⏳ <b>Verificando tu depósito…</b>\n\nPuede tardar hasta 30 segundos.',
    wallet_verified: '✅ <b>¡Depósito confirmado!</b>\n\n💵 Se han añadido <b>{amount} USDT</b> a tu cartera.',
    wallet_invalid_txid: '❌ Formato de TxID inválido. Por favor envía un hash válido.',
    wallet_already_used: '❌ <b>Este TxID ya fue utilizado.</b>',
    wallet_already_processing: '⏳ Ya se está verificando. Por favor espera...',
    wallet_timeout: '⚠️ <b>Tiempo de verificación agotado.</b>\n\nPor favor intenta de nuevo.',
    wallet_topup_expired: '⏰ <b>Esta solicitud de recarga ha expirado.</b>\n\nEra válida por {minutes} minutos. Por favor inicia una nueva recarga.',
    wallet_not_found: '❌ <b>Depósito no encontrado.</b>\n\nVerifica la dirección e intenta de nuevo.',
    wallet_topup_success: '✅ <b>¡Cartera recargada!</b>\n\n💵 Se han añadido <b>{amount} USDT</b> a tu saldo.',

    pay_select: '💳 <b>Selecciona el método de pago</b>',
    pay_wallet_label: '💰 Pagar con Cartera',
    pay_binance_label: '🟡 Binance Pay',
    pay_usdt_label: '💎 USDT',
    pay_cryptobot_label: '🤖 CryptoBot',
    pay_wallet_insufficient: '❌ <b>¡Saldo insuficiente!</b>\n\n💰 Saldo: <b>{balance}</b>\n💵 Requerido: <b>{required}</b>\n\nPor favor recarga tu cartera primero.',
    pay_out_of_stock: '❌ <b>Sin Stock</b>\n\nLo sentimos, el producto se agotó.\n\n<i>No se realizó ningún pago.</i>',
    pay_cancelled_oos: '❌ Pedido cancelado — Sin stock\n\nNo se descontó nada de tu cartera.',

    binance_instructions: '🟡 <b>Binance Pay</b>\n\n📦 Pedido #{order}\n💵 Monto: <b>{amount} USDT</b>\n\n1. Abre la app de Binance\n2. Ve a Pay → Enviar\n3. Envía exactamente <b>{amount} USDT</b> a:\n<code>{address}</code>\n4. Copia tu <b>ID de orden</b> y envíalo aquí.',
    binance_enter_orderid: '📋 Por favor envía tu <b>ID de orden Binance Pay</b>:',
    binance_verifying: '⏳ <b>Verificando transacción Binance Pay…</b>\n\n<i>Puede tardar hasta 30 segundos.</i>',

    usdt_instructions: '💎 <b>Pago USDT</b>\n\n📦 Pedido #{order}\n💵 Monto: <b>{amount} USDT</b>\n\nEnviar a:\n<code>{address}</code>\n\nLuego envía tu <b>TxID</b> aquí.',
    usdt_enter_txid: '📋 Por favor envía tu <b>Hash de transacción (TxID)</b>:',

    cryptobot_instructions: '🤖 <b>Pagar con CryptoBot</b>\n\n📦 Pedido #{order}\n💵 Monto: <b>{amount} USDT</b>\n\n👇 Toca Pagar Ahora — tu pedido se entrega automáticamente.',
    cryptobot_btn_pay: '🤖 Pagar con CryptoBot',

    delivery_title: '✅ <b>¡Pedido Entregado!</b>',
    delivery_order: 'Pedido',
    delivery_product: 'Producto',
    delivery_qty: 'Cantidad',
    delivery_total: 'Total',
    delivery_method: 'Pago',
    delivery_content: '🎁 <b>Tus Productos:</b>',
    delivery_footer: '✨ ¡Gracias por tu compra! Usa /start → Mis Pedidos para revisarlos.',

    order_status_pending: '⏳ Pendiente',
    order_status_delivered: '✅ Entregado',
    order_status_cancelled: '❌ Cancelado',

    refund_title: '🔄 <b>Solicitud de Reembolso</b>',
    refund_enter_orderid: '📋 Ingresa tu <b>ID de pedido</b> para solicitar reembolso:',
    refund_reason: '📝 Describe el motivo de tu solicitud:',
    refund_submitted: '✅ <b>¡Solicitud enviada!</b>\n\nNuestro equipo la revisará pronto.',
    refund_already: '❌ Ya existe una solicitud para este pedido.',
    refund_not_eligible: '❌ Este pedido no es elegible para reembolso.',

    stock_low_alert: '⚠️ ¡Solo quedan {count} unidades!',
    stock_out: '❌ Este producto está agotado actualmente.',
    notify_subscribed: '🔔 Te avisaremos cuando vuelva a estar disponible.',
  },
};

// Get translated string, fallback to English, fallback to key
function t(lang, key, vars = {}) {
  const safeLang = translations[lang] ? lang : 'en';
  let s = translations[safeLang][key] || translations.en[key] || key;
  // Variable replacement: {name} → value
  for (const [k, v] of Object.entries(vars)) {
    s = s.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  }
  return s;
}

const SUPPORTED_LANGS = ['en', 'ar', 'vi', 'es'];

module.exports = { t, translations, SUPPORTED_LANGS };
