import { supabase } from './supabaseClient';

export type TeacherLetterSettings = {
  school_name_zh: string;
  principal_name: string;
  chairman_name: string;
  phone: string;
  address: string;
};

const DEFAULTS: TeacherLetterSettings = {
  school_name_zh: '泰國清萊雲南會館附屬華雲學校',
  principal_name: '',
  chairman_name: '',
  phone: '',
  address: '',
};

export async function getTeacherLetterSettings(): Promise<TeacherLetterSettings> {
  const { data, error } = await supabase
    .from('teacher_letter_settings')
    .select('school_name_zh, principal_name, chairman_name, phone, address')
    .eq('id', 1)
    .maybeSingle();
  if (error || !data) return DEFAULTS;
  return data as TeacherLetterSettings;
}

export async function saveTeacherLetterSettings(settings: TeacherLetterSettings, updatedBy?: string | null): Promise<{ error?: string }> {
  const { error } = await supabase
    .from('teacher_letter_settings')
    .update({ ...settings, updated_by: updatedBy ?? null, updated_at: new Date().toISOString() })
    .eq('id', 1);
  return { error: error?.message };
}
