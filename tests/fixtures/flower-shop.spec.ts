import type { AppSpec } from "@banna/spec/schema";

export const flowerShop: AppSpec = {
  schema_version: 1,
  name: "ورد الرياض",
  category: "store",
  primary_locale: "ar",
  locales: ["ar", "en"],
  goal: "متجر ورد في الرياض يتيح للعملاء طلب الباقات والدفع وتتبع الطلب حتى التوصيل.",
  audience: "سكان الرياض الذين يشترون الورد للمناسبات",
  unique_value: "باقات المتجر الخاصة وتوصيل في نفس اليوم داخل الرياض",
  roles: [
    { name: "customer", label: "عميل", can: ["تصفح الباقات", "الطلب والدفع", "تتبع طلباته"] },
    { name: "staff", label: "موظف", can: ["إدارة الباقات", "تحديث حالة الطلبات"] },
  ],
  screens: [
    { id: "home", title: "الرئيسية", purpose: "عرض العروض والباقات", roles: [], elements: ["شريط العروض", "قائمة الباقات"], entities: ["products"] },
    { id: "product-details", title: "تفاصيل الباقة", purpose: "صور وسعر وإضافة للسلة", roles: [], elements: ["صور", "السعر", "زر الإضافة"], entities: ["products"] },
    { id: "checkout", title: "الدفع", purpose: "العنوان والدفع", roles: ["customer"], elements: ["العنوان", "Moyasar"], entities: ["orders"] },
    { id: "my-orders", title: "طلباتي", purpose: "تتبع الطلبات", roles: ["customer"], elements: ["قائمة الطلبات", "الحالة"], entities: ["orders"] },
    { id: "manage-orders", title: "إدارة الطلبات", purpose: "تحديث الحالات", roles: ["staff"], elements: ["قائمة", "تغيير الحالة"], entities: ["orders"] },
  ],
  entities: [
    {
      name: "products", label: "الباقات", description: "باقات الورد المعروضة", owner_scoped: false, public_read: true,
      fields: [
        { name: "title", label: "الاسم", type: "text", required: true, references: null, choices: null, personal_data: false },
        { name: "price", label: "السعر", type: "money", required: true, references: null, choices: null, personal_data: false },
        { name: "photo", label: "الصورة", type: "image", required: false, references: null, choices: null, personal_data: false },
      ],
    },
    {
      name: "orders", label: "الطلبات", description: "طلبات العملاء", owner_scoped: true, public_read: false,
      fields: [
        { name: "product_id", label: "الباقة", type: "reference", required: true, references: "products", choices: null, personal_data: false },
        { name: "address", label: "العنوان", type: "location", required: true, references: null, choices: null, personal_data: true },
        { name: "phone", label: "الجوال", type: "phone", required: true, references: null, choices: null, personal_data: true },
        { name: "status", label: "الحالة", type: "choice", required: true, references: null, choices: ["جديد", "قيد التجهيز", "في الطريق", "تم التوصيل"], personal_data: false },
      ],
    },
  ],
  auth: { required: false, methods: ["email_password", "phone_otp"] },
  payments: { mode: "physical_goods", description: "دفع ثمن الباقات عند الطلب" },
  notifications: ["تغيّر حالة الطلب"],
  branding: { primary_color: "#2F5D46", tone: "هادئ وأنيق" },
  out_of_scope: [],
};
