# حالة بيئة staging

آخر تحديث: 21 نوفمبر 2026

## 1. قاعدة البيانات (Supabase `banna-staging`، المرجع `townyhytnscdupxrtflv`) ✅
- الترحيلات الـ13 كلها مطبقة (3 عبر MCP و10 بملف `remaining-migrations.sql` من محرر SQL).
- **مطابقة تامة** لقاعدة الاختبار المحلية: بصمة الأعمدة والدوال وسياسات RLS متطابقة، والباقات والأسعار وحاويات التخزين الخمس صحيحة.
- لا يوجد أي جدول بدون RLS.

### فحص الأمان (Supabase Advisors)
| الملاحظة | المستوى | الحكم |
|---|---|---|
| `audit_log` و`reports` عليهما RLS بلا سياسات | INFO | مقصود: لا يصل لهما إلا الخادم (service_role). |
| `can_publish_to_stores` و`play_needs_closed_test` (SECURITY DEFINER) يستدعيهما المستخدم المسجّل | WARN | مقصود ومأمون: كل منهما يتحقق أن المستدعي هو المالك، ويعيد نعم/لا فقط. |

### فحص الأداء
- 29 مفتاحاً أجنبياً بلا فهرس (INFO): أغلبها أعمدة «من أنشأ/من راجع» قليلة الاستعلام. سأضيف فهارس للمهم منها في ترحيل صغير ضمن المرحلة 4.
- 31 فهرساً «غير مستخدم»: طبيعي لقاعدة فارغة بلا حركة.

## 2. متغيرات البيئة للمنصة على Vercel
المنصة نفسها تعمل على Vercel، فهذه المتغيرات توضع في **إعدادات مشروع Vercel** (Settings ← Environment Variables)، لا في المحادثة.

### أضعها أنا (ليست أسراراً أو أولّدها عشوائياً)
| المتغير | القيمة |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://townyhytnscdupxrtflv.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | من Supabase MCP |
| `PLATFORM_APP_URL` | رابط مشروع Vercel بعد إنشائه |
| `PLATFORM_ROOT_DOMAIN` | نطاق مؤقت للاختبار |
| `VERCEL_TEAM_ID` | `team_SRyVtWdcShYMb1TNCrys4XEB` (فريق smart-secretary) |
| `SUPABASE_APPS_ORG_SLUG` | منظمة Supabase لتطبيقات العملاء |
| `VERCEL_WEBHOOK_SECRET`، `EXPO_WEBHOOK_SECRET`، `CRON_SECRET` | أولّدها عشوائياً مباشرة في Vercel |

### يضعها مصعب بنفسه في Vercel (أسرار)
| المتغير | من أين |
|---|---|
| `SUPABASE_SECRET_KEY` | Supabase ← banna-staging ← Settings ← API Keys ← Secret key (`sb_secret_…`) |
| `SUPABASE_MANAGEMENT_TOKEN` | supabase.com/dashboard/account/tokens |
| `ANTHROPIC_API_KEY` | console.anthropic.com ← API Keys |
| `VERCEL_TOKEN` | vercel.com/account/tokens |
| `EXPO_TOKEN` و`EXPO_OWNER` | expo.dev ← Access tokens، واسم الحساب |
| `MOYASAR_PUBLISHABLE_KEY` و`MOYASAR_SECRET_KEY` | لوحة Moyasar ← مفاتيح **الاختبار** (`pk_test_` / `sk_test_`) |

## 3. التالي
- إنشاء مشروع Vercel (Hobby) للمنصة ورفع الشيفرة إليه.
- اختبارات المرحلة 4 الآلية (مصفوفة التتبع، RLS، تكامل الواجهات، E2E، مراجعة أمنية).
