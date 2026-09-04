import { createClient } from '@supabase/supabase-js';

// ⚠️ 這個檔案只能在伺服器端（API route）使用，絕對不能 import 進任何前端元件。
// SUPABASE_SERVICE_ROLE_KEY 不加 NEXT_PUBLIC_ 前綴，才不會被打包進前端程式碼。
export const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
);
